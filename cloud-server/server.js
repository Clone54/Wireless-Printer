const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const PRINT_TOKEN = process.env.PRINT_TOKEN || 'changeme123';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'firozahmedshoykot44@gmail.com').toLowerCase();
const RATE_COLOR_BDT = 4;
const RATE_BW_BDT = 3;
const PPD_PATH = '/etc/cups/ppd/epson_l3210.ppd';
const JOBS_DIR = '/tmp/jobs';
const UPLOADS_DIR = '/tmp/uploads';

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- Firebase Admin (Firestore + Auth Verification) ---
let db = null;
let admin = null;
let webConfig = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    admin = require('firebase-admin');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('[Firebase] Admin SDK & Firestore connected');
  } catch (err) {
    console.error('[Firebase] Admin init failed:', err.message);
    db = null;
  }
} else {
  console.log('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set');
}

if (process.env.FIREBASE_WEB_CONFIG_JSON) {
  try {
    webConfig = JSON.parse(process.env.FIREBASE_WEB_CONFIG_JSON);
  } catch (err) {
    console.error('[Firebase] Invalid FIREBASE_WEB_CONFIG_JSON:', err.message);
  }
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const jobs = [];
const memoryUserDues = {};
let lastEspSeen = 0;
let espPrinterStatus = 'Unknown';
let espWifiSsid = '';

function computeDueBdt(colorPages, bwPages) {
  return (Number(colorPages || 0) * RATE_COLOR_BDT) + (Number(bwPages || 0) * RATE_BW_BDT);
}

function decodeFilename(name) {
  if (!name) return 'Document';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function requireDeviceToken(req, res, next) {
  const token = req.headers['x-print-token'] || req.query.token;
  if (!token || token !== PRINT_TOKEN) {
    return res.status(401).json({ error: 'Invalid PRINT_TOKEN' });
  }
  next();
}

async function requireGoogleUser(req, res, next) {
  if (!admin) {
    return res.status(500).json({ error: 'Firebase Admin not configured on server' });
  }
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Missing Google sign-in token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    const email = (decoded.email || '').toLowerCase();
    req.user = {
      uid: decoded.uid,
      email,
      name: decoded.name || email || 'User',
      picture: decoded.picture || '',
      isAdmin: email === ADMIN_EMAIL
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired Google session' });
  }
}

function parseDeviceInfo(req) {
  const ua = String(req.headers['user-agent'] || '');
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

  if (req.headers['x-device-name']) {
    return { device: String(req.headers['x-device-name']).slice(0, 60), ua, ip };
  }

  let os = 'Unknown OS';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  else if (/Python-urllib/i.test(ua)) browser = 'Laptop Relay';

  return { device: `${os} • ${browser}`, ua: ua.slice(0, 180), ip };
}

function describeHeader(buf) {
  if (!buf || buf.length === 0) return 'EMPTY (0 bytes)';
  const ascii = buf.slice(0, 24).toString('latin1').replace(/[^\x20-\x7E]/g, '.');
  const hex = buf.slice(0, 12).toString('hex');
  return `${buf.length} bytes [ascii="${ascii}" hex=${hex}]`;
}

function isValidEscpr(buf) {
  if (!buf || buf.length < 32) return false;
  const head = buf.slice(0, 8).toString('latin1');
  if (
    head.startsWith('%PDF-') ||
    head.startsWith('%!PS') ||
    head.startsWith('3SaR') ||
    head.startsWith('RaS3') ||
    head.startsWith('2SaR') ||
    head.startsWith('RaS2') ||
    head.startsWith('<!DOC') ||
    head.startsWith('<html')
  ) {
    return false;
  }
  const sample = buf.slice(0, Math.min(buf.length, 8192)).toString('latin1');
  return (
    sample.includes('ESCPR') ||
    sample.includes('@EJL') ||
    sample.includes('REMOTE1') ||
    sample.includes('EPSON') ||
    (buf[0] === 0x1b && buf[1] === 0x40)
  );
}

function runFilter(cmd, args, stdinBuf, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...envExtra },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (err) => {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf8').slice(-600)
      });
    });
    if (stdinBuf && stdinBuf.length > 0) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinBuf);
    } else {
      child.stdin.end();
    }
  });
}

async function countSelectedPages(filePath, ext, pageMode, customPages) {
  if (ext !== '.pdf') return 1;

  const info = await runFilter('pdfinfo', [filePath], null);
  const match = info.stdout.toString('utf8').match(/Pages:\s+(\d+)/i);
  const totalPdfPages = match ? Math.max(1, parseInt(match[1], 10)) : 1;

  if (pageMode === 'odd') return Math.ceil(totalPdfPages / 2);
  if (pageMode === 'even') return Math.max(0, Math.floor(totalPdfPages / 2));
  if (pageMode === 'custom' && customPages) {
    const selected = new Set();
    for (const part of customPages.split(',')) {
      const range = part.trim().split('-').map(n => parseInt(n, 10));
      if (range.length === 1 && !isNaN(range[0])) {
        if (range[0] >= 1 && range[0] <= totalPdfPages) selected.add(range[0]);
      } else if (range.length === 2 && !isNaN(range[0]) && !isNaN(range[1])) {
        const start = Math.max(1, Math.min(range[0], range[1]));
        const end = Math.min(totalPdfPages, Math.max(range[0], range[1]));
        for (let p = start; p <= end; p++) selected.add(p);
      }
    }
    return selected.size > 0 ? selected.size : totalPdfPages;
  }
  return totalPdfPages;
}

async function upsertUserOnLogin(user, devInfo) {
  if (!db) return;
  try {
    await db.collection('users').doc(user.uid).set({
      uid: user.uid,
      email: user.email,
      name: user.name,
      role: user.isAdmin ? 'admin' : 'user',
      lastDevice: devInfo.device,
      lastIp: devInfo.ip,
      lastSeen: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error('[Firestore] Upsert user failed:', err.message);
  }
}

async function saveJobToFirestore(job) {
  if (!db) return;
  try {
    await db.collection('print_jobs').doc(job.id).set({
      jobId: job.id,
      uid: job.uid,
      userEmail: job.userEmail,
      userName: job.userName,
      name: job.name,
      source: job.source,
      device: job.device,
      ip: job.ip,
      colorMode: job.colorMode,
      pagesPerCopy: job.pagesPerCopy,
      pagesPerSheet: job.pagesPerSheet,
      copies: job.copies,
      totalPages: job.totalPages,
      costBdt: job.costBdt,
      paper: job.paper,
      orientation: job.orientation,
      quality: job.quality,
      pageMode: job.pageMode,
      customPages: job.customPages || '',
      size: job.size,
      status: job.status,
      createdAt: job.createdAt,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('[Firestore] Save job failed:', err.message);
  }
}

async function updateJobStatusInFirestore(job, ok) {
  if (ok && job.uid) {
    if (!memoryUserDues[job.uid]) memoryUserDues[job.uid] = { dueColorPages: 0, dueBwPages: 0 };
    if (job.colorMode === 'Color') memoryUserDues[job.uid].dueColorPages += job.totalPages;
    else memoryUserDues[job.uid].dueBwPages += job.totalPages;
  }

  if (!db) return;
  try {
    await db.collection('print_jobs').doc(job.id).update({
      status: job.status,
      completedAt: new Date().toISOString()
    });
    if (ok) {
      const inc = admin.firestore.FieldValue.increment;
      const colorInc = job.colorMode === 'Color' ? job.totalPages : 0;
      const bwInc = job.colorMode === 'B&W' ? job.totalPages : 0;
      const costInc = computeDueBdt(colorInc, bwInc);

      await db.collection('stats').doc('summary').set({
        totalJobs: inc(1),
        totalPages: inc(job.totalPages),
        colorPages: inc(colorInc),
        bwPages: inc(bwInc),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      if (job.uid) {
        await db.collection('users').doc(job.uid).set({
          uid: job.uid,
          email: job.userEmail,
          name: job.userName,
          totalJobs: inc(1),
          totalPages: inc(job.totalPages),
          colorPages: inc(colorInc),
          bwPages: inc(bwInc),
          dueColorPages: inc(colorInc),
          dueBwPages: inc(bwInc),
          dueAmountBdt: inc(costInc),
          lastDevice: job.device,
          lastIp: job.ip,
          lastPrintAt: job.createdAt
        }, { merge: true });
      }
    }
  } catch (err) {
    console.error('[Firestore] Update status failed:', err.message);
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/public-config', (req, res) => {
  res.json({
    firebaseConfig: webConfig,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    firestoreEnabled: Boolean(db),
    rates: { colorBdt: RATE_COLOR_BDT, bwBdt: RATE_BW_BDT }
  });
});

app.post('/api/me', requireGoogleUser, async (req, res) => {
  const devInfo = parseDeviceInfo(req);
  await upsertUserOnLogin(req.user, devInfo);
  res.json({ user: req.user });
});

app.post('/api/admin/reset-due', requireGoogleUser, express.json(), async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only Admin can reset user dues' });
  }
  const targetUid = req.body && req.body.uid;
  if (!targetUid) {
    return res.status(400).json({ error: 'Missing user uid' });
  }

  memoryUserDues[targetUid] = { dueColorPages: 0, dueBwPages: 0 };

  if (db) {
    try {
      await db.collection('users').doc(targetUid).set({
        dueColorPages: 0,
        dueBwPages: 0,
        dueAmountBdt: 0,
        dueResetFlag: true,
        lastPaidAt: new Date().toISOString(),
        lastPaidBy: req.user.email
      }, { merge: true });
    } catch (err) {
      return res.status(500).json({ error: `Failed to reset due in Firestore: ${err.message}` });
    }
  }

  console.log(`[Admin] Reset due for uid=${targetUid} by ${req.user.email}`);
  res.json({ ok: true });
});

app.post('/api/print-file', requireGoogleUser, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const originalName = decodeFilename(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase() || '.pdf';
  const inputPath = `${req.file.path}${ext}`;
  fs.renameSync(req.file.path, inputPath);

  const cleanup = () => {
    fs.unlink(inputPath, () => {});
  };

  if (!fs.existsSync(PPD_PATH)) {
    cleanup();
    return res.status(500).json({ error: 'Epson PPD (/etc/cups/ppd/epson_l3210.ppd) not found in container' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const outPath = path.join(JOBS_DIR, `${jobId}.prn`);
  const paper = ['A4', 'A5', 'Letter'].includes(req.body.paper) ? req.body.paper : 'A4';
  const isGray = (req.body.color === 'Gray' || req.body.color === 'MONO');
  const ink = isGray ? 'MONO' : 'COLOR';
  const colorMode = isGray ? 'B&W' : 'Color';
  const copies = Math.max(1, Math.min(20, parseInt(req.body.copies || '1', 10) || 1));
  const pagesPerSheet = [1, 2, 4, 6, 9, 16].includes(parseInt(req.body.pagesPerSheet, 10))
    ? parseInt(req.body.pagesPerSheet, 10)
    : 1;
  const orientation = req.body.orientation === 'landscape' ? 'landscape' : 'portrait';
  const pageOrder = req.body.pageOrder === 'normal' ? 'normal' : 'reverse';
  const pageMode = req.body.pageMode || 'all';
  const customPages = String(req.body.customPages || '').replace(/[^0-9,\-]/g, '');
  const quality = ['PLAIN_NORMAL', 'PLAIN_HIGH', 'PMPHOTO_NORMAL'].includes(req.body.quality)
    ? req.body.quality
    : 'PLAIN_NORMAL';

  const selectedPages = await countSelectedPages(inputPath, ext, pageMode, customPages);
  if (selectedPages === 0) {
    cleanup();
    return res.status(400).json({ error: 'No pages matched your selected page filter.' });
  }
  const sheetsPerCopy = Math.ceil(selectedPages / pagesPerSheet);
  const totalPages = sheetsPerCopy * copies;
  const costBdt = colorMode === 'Color' ? (totalPages * RATE_COLOR_BDT) : (totalPages * RATE_BW_BDT);
  const devInfo = parseDeviceInfo(req);

  const cupsOpts = [
    '-o', `PageSize=${paper}`,
    '-o', `media=${paper}`,
    '-o', `Ink=${ink}`,
    '-o', `MediaType=${quality}`,
    '-o', 'fit-to-page'
  ];

  if (orientation === 'landscape') cupsOpts.push('-o', 'landscape');
  if (pageOrder === 'reverse') cupsOpts.push('-o', 'outputorder=reverse');
  if (pagesPerSheet > 1) cupsOpts.push('-o', `number-up=${pagesPerSheet}`);
  if (pageMode === 'odd') cupsOpts.push('-o', 'page-set=odd');
  else if (pageMode === 'even') cupsOpts.push('-o', 'page-set=even');
  else if (pageMode === 'custom' && customPages) cupsOpts.push('-o', `page-ranges=${customPages}`);

  const optsStr = `PageSize=${paper} media=${paper} Ink=${ink} MediaType=${quality} fit-to-page`;
  const envVars = { PPD: PPD_PATH, PRINTER: 'epson_l3210', CUPS_SERVERROOT: '/etc/cups' };

  try {
    const a1 = await runFilter('cupsfilter', [
      '-e', '-p', PPD_PATH, '-d', 'epson_l3210', '-m', 'printer/foo',
      ...cupsOpts, '-o', `copies=${copies}`, inputPath
    ], null, envVars);

    let finalBuf = a1.stdout;
    let diagLog = `A1(cupsfilter -e): ${describeHeader(a1.stdout)} err=[${a1.stderr.trim()}]`;

    if (!isValidEscpr(finalBuf)) {
      const a2Ras = await runFilter('cupsfilter', [
        '-p', PPD_PATH, '-m', 'application/vnd.cups-raster', ...cupsOpts, inputPath
      ], null, envVars);

      diagLog += ` | A2-Raster: ${describeHeader(a2Ras.stdout)}`;
      let rasterBuf = a2Ras.stdout;

      if (!rasterBuf || rasterBuf.length < 64) {
        let pdfPath = inputPath;
        if (ext !== '.pdf') {
          pdfPath = `${inputPath}.pdf`;
          await runFilter('convert', [inputPath, '-page', paper, pdfPath], null);
        }
        const gsRas = await runFilter('gs', [
          '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
          '-sDEVICE=cups', '-r360x360', `-sPAPERSIZE=${paper.toLowerCase()}`,
          '-dcupsColorSpace=1', '-dcupsBitsPerColor=8', '-dcupsColorOrder=0',
          '-sOutputFile=-', pdfPath
        ], null, envVars);
        if (pdfPath !== inputPath) fs.unlink(pdfPath, () => {});
        rasterBuf = gsRas.stdout;
        diagLog += ` | A3-GS-Raster: ${describeHeader(rasterBuf)} err=[${gsRas.stderr.trim()}]`;
      }

      if (rasterBuf && rasterBuf.length >= 64) {
        const wrapRes = await runFilter(
          '/usr/lib/cups/filter/epson-escpr-wrapper',
          ['1', 'root', originalName, String(copies), optsStr],
          rasterBuf, envVars
        );
        finalBuf = wrapRes.stdout;
        diagLog += ` | Wrapper: ${describeHeader(finalBuf)} err=[${wrapRes.stderr.trim()}]`;
      }
    }

    cleanup();
    console.log('[CUPS Pipeline]', diagLog);

    if (!isValidEscpr(finalBuf)) {
      return res.status(500).json({ error: `Safety block (no paper wasted). Diagnostics: ${diagLog}` });
    }

    fs.writeFileSync(outPath, finalBuf);
    const job = {
      id: jobId,
      uid: req.user.uid,
      userEmail: req.user.email,
      userName: req.user.name,
      name: originalName,
      source: 'Web/Phone',
      device: devInfo.device,
      ip: devInfo.ip,
      colorMode,
      pagesPerCopy: sheetsPerCopy,
      pagesPerSheet,
      copies,
      totalPages,
      costBdt,
      paper,
      orientation,
      quality,
      pageMode,
      customPages,
      size: finalBuf.length,
      status: 'queued',
      createdAt: new Date().toISOString(),
      filePath: outPath
    };
    jobs.push(job);
    await saveJobToFirestore(job);
    console.log(`[Queue] Job ${jobId} by ${req.user.email} (${totalPages}p ${colorMode}, ${costBdt} BDT)`);
    return res.json({ ok: true, job: { id: job.id, name: job.name, size: job.size, totalPages, colorMode, costBdt, status: job.status } });
  } catch (e) {
    cleanup();
    return res.status(500).json({ error: `Conversion exception: ${e.message}` });
  }
});

app.post('/api/print-raw', requireDeviceToken, express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'Empty print payload' });
  }
  if (!isValidEscpr(req.body)) {
    return res.status(400).json({ error: `Rejected non-ESC/P-R payload: ${describeHeader(req.body)}` });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const outPath = path.join(JOBS_DIR, `${jobId}.prn`);
  fs.writeFileSync(outPath, req.body);

  const devInfo = parseDeviceInfo(req);
  const job = {
    id: jobId,
    uid: 'admin_laptop_relay',
    userEmail: ADMIN_EMAIL,
    userName: 'Admin (Laptop Relay)',
    name: req.headers['x-job-name'] || `Laptop Job ${jobId}`,
    source: 'Laptop',
    device: devInfo.device,
    ip: devInfo.ip,
    colorMode: 'Color',
    pagesPerCopy: 1,
    pagesPerSheet: 1,
    copies: 1,
    totalPages: 1,
    costBdt: RATE_COLOR_BDT,
    paper: 'A4',
    orientation: 'portrait',
    quality: 'Driver',
    pageMode: 'all',
    customPages: '',
    size: req.body.length,
    status: 'queued',
    createdAt: new Date().toISOString(),
    filePath: outPath
  };
  jobs.push(job);
  await saveJobToFirestore(job);
  res.json({ ok: true, jobId, size: job.size });
});

// Auto-recover jobs stuck in 'printing' > 2 minutes without stream activity
function recoverStuckJobs() {
  const now = Date.now();
  for (const j of jobs) {
    if (j.status === 'printing' && j.printingAt && (now - j.printingAt > 120000)) {
      j.retries = (j.retries || 0) + 1;
      if (j.retries <= 2 && fs.existsSync(j.filePath)) {
        j.status = 'queued';
        console.log(`[Queue] Re-queued stalled job ${j.id} (retry ${j.retries})`);
      } else {
        j.status = 'failed';
        if (fs.existsSync(j.filePath)) fs.unlink(j.filePath, () => {});
        updateJobStatusInFirestore(j, false);
        console.log(`[Queue] Marked stalled job ${j.id} as failed`);
      }
    }
  }
}

app.post('/api/jobs/:id/cancel', requireGoogleUser, async (req, res) => {
  const jobId = req.params.id;
  const memJob = jobs.find(j => j.id === jobId);
  if (memJob) {
    if (!req.user.isAdmin && memJob.uid !== req.user.uid) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    memJob.status = 'cancelled';
    if (fs.existsSync(memJob.filePath)) fs.unlink(memJob.filePath, () => {});
  }
  if (db) {
    try {
      const docRef = db.collection('print_jobs').doc(jobId);
      const snap = await docRef.get();
      if (snap.exists) {
        const d = snap.data();
        if (!req.user.isAdmin && d.uid !== req.user.uid) {
          return res.status(403).json({ error: 'Not allowed' });
        }
        await docRef.update({ status: 'cancelled' });
      }
    } catch (e) {}
  }
  res.json({ ok: true });
});

app.get('/api/esp/poll', requireDeviceToken, (req, res) => {
  lastEspSeen = Date.now();
  if (req.query.status) {
    espPrinterStatus = String(req.query.status).slice(0, 40);
  }
  if (typeof req.query.ssid === 'string') {
    espWifiSsid = req.query.ssid.slice(0, 64);
  }
  if (req.query.hb === '1') {
    if (req.query.jobId && req.query.pct !== undefined) {
      const activeJob = jobs.find(j => j.id === req.query.jobId && j.status === 'printing');
      if (activeJob) {
        activeJob.progress = Math.min(99, Math.max(0, parseInt(req.query.pct, 10) || 0));
        activeJob.printingAt = Date.now();
      }
    }
    return res.status(204).end();
  }
  recoverStuckJobs();
  const nextJob = jobs.find(j => j.status === 'queued');
  if (!nextJob) return res.status(204).end();
  nextJob.status = 'printing';
  nextJob.printingAt = Date.now();
  res.json({ id: nextJob.id, size: nextJob.size, name: nextJob.name });
});

app.get('/api/esp/job/:id', requireDeviceToken, (req, res) => {
  lastEspSeen = Date.now();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job || !fs.existsSync(job.filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', job.size);
  const stream = fs.createReadStream(job.filePath);
  stream.on('data', () => { lastEspSeen = Date.now(); job.printingAt = Date.now(); });
  stream.pipe(res);
});

app.post('/api/esp/job/:id/done', requireDeviceToken, express.json(), async (req, res) => {
  lastEspSeen = Date.now();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const ok = !req.body || req.body.ok !== false;
  job.status = ok ? 'completed' : 'failed';
  job.progress = ok ? 100 : (job.progress || 0);
  if (fs.existsSync(job.filePath)) fs.unlink(job.filePath, () => {});
  await updateJobStatusInFirestore(job, ok);
  res.json({ ok: true });
});

function resolveUserDueBdt(u) {
  if (typeof u.dueAmountBdt === 'number') return u.dueAmountBdt;
  if (u.dueResetFlag) return computeDueBdt(u.dueColorPages || 0, u.dueBwPages || 0);
  return computeDueBdt(u.colorPages || 0, u.bwPages || 0);
}

function getJobQueueMeta(jobId, status) {
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) {
    return { progress: status === 'completed' ? 100 : 0, waitingPages: 0 };
  }
  const mem = jobs[idx];
  let waitingPages = 0;
  if (mem.status === 'queued') {
    for (let i = 0; i < idx; i++) {
      if (jobs[i].status === 'printing' || jobs[i].status === 'queued') {
        waitingPages += Number(jobs[i].totalPages || 1);
      }
    }
  }
  return {
    progress: mem.status === 'completed' ? 100 : (mem.progress || 0),
    waitingPages
  };
}

app.get('/api/status', requireGoogleUser, async (req, res) => {
  const espOnline = (Date.now() - lastEspSeen) < 15000;
  const isAdmin = req.user.isAdmin;

  let summary = { totalJobs: 0, totalPages: 0, colorPages: 0, bwPages: 0, dueAmountBdt: 0 };
  let recentJobs = [];
  let allUsers = [];

  if (db) {
    try {
      if (isAdmin) {
        const sumDoc = await db.collection('stats').doc('summary').get();
        if (sumDoc.exists) {
          const d = sumDoc.data();
          summary.totalJobs = d.totalJobs || 0;
          summary.totalPages = d.totalPages || 0;
          summary.colorPages = d.colorPages || 0;
          summary.bwPages = d.bwPages || 0;
        }

        const jobsSnap = await db.collection('print_jobs').orderBy('timestamp', 'desc').limit(30).get();
        const activeIds = new Set(jobs.map(j => j.id));
        const tenMinAgo = Date.now() - 10 * 60 * 1000;
        recentJobs = jobsSnap.docs.map(doc => {
          const d = doc.data();
          let st = d.status;
          if ((st === 'queued' || st === 'printing') && !activeIds.has(d.jobId || doc.id)) {
            const ts = d.createdAt ? Date.parse(d.createdAt) : 0;
            if (ts && ts < tenMinAgo) {
              st = 'expired';
              doc.ref.update({ status: 'expired' }).catch(() => {});
            }
          }
          return {
            id: d.jobId || doc.id,
            name: d.name,
            userEmail: d.userEmail || '',
            device: d.device || d.source,
            colorMode: d.colorMode || 'Color',
            totalPages: d.totalPages || 1,
            costBdt: typeof d.costBdt === 'number'
              ? d.costBdt
              : computeDueBdt(d.colorMode === 'Color' ? (d.totalPages || 1) : 0, d.colorMode === 'B&W' ? (d.totalPages || 1) : 0),
            status: st,
            ...getJobQueueMeta(d.jobId || doc.id, st),
            createdAt: d.createdAt
          };
        });

        const usersSnap = await db.collection('users').get();
        let totalUnpaidBdt = 0;
        allUsers = usersSnap.docs.map(doc => {
          const u = doc.data();
          const dueBdt = resolveUserDueBdt(u);
          totalUnpaidBdt += dueBdt;
          return {
            uid: u.uid || doc.id,
            email: u.email || '',
            name: u.name || '',
            role: u.role || 'user',
            totalJobs: u.totalJobs || 0,
            totalPages: u.totalPages || 0,
            colorPages: u.colorPages || 0,
            bwPages: u.bwPages || 0,
            dueAmountBdt: dueBdt,
            lastDevice: u.lastDevice || '—'
          };
        }).sort((a, b) => (b.dueAmountBdt - a.dueAmountBdt) || (b.totalPages - a.totalPages));
        summary.dueAmountBdt = totalUnpaidBdt;
      } else {
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (userDoc.exists) {
          const u = userDoc.data();
          summary = {
            totalJobs: u.totalJobs || 0,
            totalPages: u.totalPages || 0,
            colorPages: u.colorPages || 0,
            bwPages: u.bwPages || 0,
            dueAmountBdt: resolveUserDueBdt(u)
          };
        }

        const myJobsSnap = await db.collection('print_jobs').where('uid', '==', req.user.uid).limit(50).get();
        recentJobs = myJobsSnap.docs
          .map(doc => {
            const d = doc.data();
            return {
              id: d.jobId || doc.id,
              name: d.name,
              colorMode: d.colorMode || 'Color',
              totalPages: d.totalPages || 1,
              costBdt: typeof d.costBdt === 'number'
                ? d.costBdt
                : computeDueBdt(d.colorMode === 'Color' ? (d.totalPages || 1) : 0, d.colorMode === 'B&W' ? (d.totalPages || 1) : 0),
              status: d.status,
              ...getJobQueueMeta(d.jobId || doc.id, d.status),
              createdAt: d.createdAt
            };
          })
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 20);
      }
    } catch (err) {
      console.error('[Firestore] Read error:', err.message);
    }
  } else {
    const visible = isAdmin ? jobs : jobs.filter(j => j.uid === req.user.uid);
    recentJobs = visible.slice(-20).reverse().map(j => ({ ...j, ...getJobQueueMeta(j.id, j.status) }));
    for (const j of visible) {
      if (j.status === 'completed') {
        summary.totalJobs += 1;
        summary.totalPages += j.totalPages;
        if (j.colorMode === 'Color') summary.colorPages += j.totalPages;
        else summary.bwPages += j.totalPages;
      }
    }
    const memDue = memoryUserDues[req.user.uid] || { dueColorPages: 0, dueBwPages: 0 };
    summary.dueAmountBdt = computeDueBdt(memDue.dueColorPages, memDue.dueBwPages);
  }

  res.json({
    espOnline,
    espPrinterStatus: espOnline ? espPrinterStatus : 'Offline',
    espWifiSsid: (isAdmin && espOnline) ? espWifiSsid : undefined,
    user: req.user,
    rates: { colorBdt: RATE_COLOR_BDT, bwBdt: RATE_BW_BDT },
    summary,
    jobs: recentJobs,
    allUsers: isAdmin ? allUsers : []
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Cloud Print Relay listening on port ${PORT}`);
});
