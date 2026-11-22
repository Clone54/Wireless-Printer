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
const PPD_PATH = '/etc/cups/ppd/epson_l3210.ppd';
const JOBS_DIR = '/tmp/jobs';
const UPLOADS_DIR = '/tmp/uploads';

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- Optional Firebase Firestore Initialization ---
let db = null;
let admin = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    admin = require('firebase-admin');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('[Firestore] Connected successfully');
  } catch (err) {
    console.error('[Firestore] Init failed, falling back to in-memory:', err.message);
    db = null;
  }
} else {
  console.log('[Firestore] FIREBASE_SERVICE_ACCOUNT_JSON not set; using in-memory history');
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const jobs = [];
const memoryStats = { totalJobs: 0, totalPages: 0, colorPages: 0, bwPages: 0 };
let lastEspSeen = 0;
let espPrinterStatus = 'Unknown';

function requireToken(req, res, next) {
  const token = req.headers['x-print-token'] || req.query.token || (req.body && req.body.token);
  if (!token || token !== PRINT_TOKEN) {
    return res.status(401).json({ error: 'Invalid password (PRINT_TOKEN)' });
  }
  next();
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

  if (pageMode === 'odd') {
    return Math.ceil(totalPdfPages / 2);
  }
  if (pageMode === 'even') {
    return Math.max(0, Math.floor(totalPdfPages / 2));
  }
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

async function saveJobToFirestore(job) {
  if (!db) return;
  try {
    await db.collection('print_jobs').doc(job.id).set({
      jobId: job.id,
      name: job.name,
      source: job.source,
      device: job.device,
      ip: job.ip,
      colorMode: job.colorMode,
      pagesPerCopy: job.pagesPerCopy,
      copies: job.copies,
      totalPages: job.totalPages,
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
  if (!db) return;
  try {
    await db.collection('print_jobs').doc(job.id).update({
      status: job.status,
      completedAt: new Date().toISOString()
    });
    if (ok) {
      const inc = admin.firestore.FieldValue.increment;
      await db.collection('stats').doc('summary').set({
        totalJobs: inc(1),
        totalPages: inc(job.totalPages),
        colorPages: inc(job.colorMode === 'Color' ? job.totalPages : 0),
        bwPages: inc(job.colorMode === 'B&W' ? job.totalPages : 0),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } catch (err) {
    console.error('[Firestore] Update status failed:', err.message);
  }
}

app.use(express.static(path.join(__dirname, 'public')));

// Verify password (PRINT_TOKEN) for login screen
app.post('/api/auth', express.json(), (req, res) => {
  const token = (req.body && req.body.token) || req.headers['x-print-token'] || '';
  if (!token || token !== PRINT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Incorrect password' });
  }
  res.json({ ok: true, firestoreEnabled: Boolean(db) });
});

app.post('/api/print-file', upload.single('file'), requireToken, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.pdf';
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
  const paper = req.body.paper === 'Letter' ? 'Letter' : 'A4';
  const isGray = (req.body.color === 'Gray' || req.body.color === 'MONO');
  const ink = isGray ? 'MONO' : 'COLOR';
  const colorMode = isGray ? 'B&W' : 'Color';
  const copies = Math.max(1, Math.min(20, parseInt(req.body.copies || '1', 10) || 1));
  const orientation = req.body.orientation === 'landscape' ? 'landscape' : 'portrait';
  const pageMode = req.body.pageMode || 'all';
  const customPages = String(req.body.customPages || '').replace(/[^0-9,\-]/g, '');
  const quality = ['PLAIN_NORMAL', 'PLAIN_HIGH', 'PMPHOTO_NORMAL'].includes(req.body.quality)
    ? req.body.quality
    : 'PLAIN_NORMAL';

  const pagesPerCopy = await countSelectedPages(inputPath, ext, pageMode, customPages);
  if (pagesPerCopy === 0) {
    cleanup();
    return res.status(400).json({ error: 'No pages matched your selected page filter (e.g. Even pages on a 1-page PDF).' });
  }
  const totalPages = pagesPerCopy * copies;
  const devInfo = parseDeviceInfo(req);

  const cupsOpts = [
    '-o', `PageSize=${paper}`,
    '-o', `media=${paper}`,
    '-o', `Ink=${ink}`,
    '-o', `MediaType=${quality}`,
    '-o', 'fit-to-page'
  ];

  if (orientation === 'landscape') {
    cupsOpts.push('-o', 'landscape');
  }
  if (pageMode === 'odd') {
    cupsOpts.push('-o', 'page-set=odd');
  } else if (pageMode === 'even') {
    cupsOpts.push('-o', 'page-set=even');
  } else if (pageMode === 'custom' && customPages) {
    cupsOpts.push('-o', `page-ranges=${customPages}`);
  }

  const optsStr = `PageSize=${paper} media=${paper} Ink=${ink} MediaType=${quality} fit-to-page`;
  const envVars = { PPD: PPD_PATH, PRINTER: 'epson_l3210', CUPS_SERVERROOT: '/etc/cups' };

  try {
    const a1 = await runFilter('cupsfilter', [
      '-e',
      '-p', PPD_PATH,
      '-d', 'epson_l3210',
      '-m', 'printer/foo',
      ...cupsOpts,
      '-o', `copies=${copies}`,
      inputPath
    ], null, envVars);

    let finalBuf = a1.stdout;
    let diagLog = `A1(cupsfilter -e): ${describeHeader(a1.stdout)} err=[${a1.stderr.trim()}]`;

    if (!isValidEscpr(finalBuf)) {
      const a2Ras = await runFilter('cupsfilter', [
        '-p', PPD_PATH,
        '-m', 'application/vnd.cups-raster',
        ...cupsOpts,
        inputPath
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
          '-sDEVICE=cups',
          '-r360x360',
          `-sPAPERSIZE=${paper.toLowerCase()}`,
          '-dcupsColorSpace=1',
          '-dcupsBitsPerColor=8',
          '-dcupsColorOrder=0',
          '-sOutputFile=-',
          pdfPath
        ], null, envVars);
        if (pdfPath !== inputPath) fs.unlink(pdfPath, () => {});
        rasterBuf = gsRas.stdout;
        diagLog += ` | A3-GS-Raster: ${describeHeader(rasterBuf)} err=[${gsRas.stderr.trim()}]`;
      }

      if (rasterBuf && rasterBuf.length >= 64) {
        const wrapRes = await runFilter(
          '/usr/lib/cups/filter/epson-escpr-wrapper',
          ['1', 'root', req.file.originalname || 'Job', String(copies), optsStr],
          rasterBuf,
          envVars
        );
        finalBuf = wrapRes.stdout;
        diagLog += ` | Wrapper: ${describeHeader(finalBuf)} err=[${wrapRes.stderr.trim()}]`;
      }
    }

    cleanup();
    console.log('[CUPS Pipeline]', diagLog);

    if (!isValidEscpr(finalBuf)) {
      return res.status(500).json({
        error: `Safety block (no paper wasted). Diagnostics: ${diagLog}`
      });
    }

    fs.writeFileSync(outPath, finalBuf);
    const job = {
      id: jobId,
      name: req.file.originalname || 'Document',
      source: 'Web/Phone',
      device: devInfo.device,
      ip: devInfo.ip,
      colorMode,
      pagesPerCopy,
      copies,
      totalPages,
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
    console.log(`[Queue] Verified ESC/P-R job ${jobId} (${job.name}, ${totalPages}p ${colorMode}, ${devInfo.device})`);
    return res.json({ ok: true, job: { id: job.id, name: job.name, size: job.size, totalPages, colorMode, status: job.status } });
  } catch (e) {
    cleanup();
    return res.status(500).json({ error: `Conversion exception: ${e.message}` });
  }
});

app.post('/api/print-raw', requireToken, express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
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
    name: req.headers['x-job-name'] || `Laptop Job ${jobId}`,
    source: 'Laptop',
    device: devInfo.device,
    ip: devInfo.ip,
    colorMode: 'Color',
    pagesPerCopy: 1,
    copies: 1,
    totalPages: 1,
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
  console.log(`[Queue] Added raw job ${jobId} (${job.size} bytes)`);
  res.json({ ok: true, jobId, size: job.size });
});

app.get('/api/esp/poll', requireToken, (req, res) => {
  lastEspSeen = Date.now();
  if (req.query.status) {
    espPrinterStatus = String(req.query.status).slice(0, 40);
  }

  const nextJob = jobs.find(j => j.status === 'queued');
  if (!nextJob) {
    return res.status(204).end();
  }

  nextJob.status = 'printing';
  res.json({ id: nextJob.id, size: nextJob.size, name: nextJob.name });
});

app.get('/api/esp/job/:id', requireToken, (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);
  if (!job || !fs.existsSync(job.filePath)) {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', job.size);
  fs.createReadStream(job.filePath).pipe(res);
});

app.post('/api/esp/job/:id/done', requireToken, express.json(), async (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const ok = !req.body || req.body.ok !== false;
  job.status = ok ? 'completed' : 'failed';
  if (fs.existsSync(job.filePath)) {
    fs.unlink(job.filePath, () => {});
  }
  if (ok) {
    memoryStats.totalJobs += 1;
    memoryStats.totalPages += job.totalPages;
    if (job.colorMode === 'Color') memoryStats.colorPages += job.totalPages;
    else memoryStats.bwPages += job.totalPages;
  }
  await updateJobStatusInFirestore(job, ok);
  console.log(`[Queue] Job ${job.id} -> ${job.status}`);
  res.json({ ok: true });
});

app.get('/api/status', requireToken, async (req, res) => {
  const espOnline = (Date.now() - lastEspSeen) < 15000;
  let summary = { ...memoryStats };
  let recentJobs = jobs.slice(-20).reverse().map(j => ({
    id: j.id,
    name: j.name,
    source: j.source,
    device: j.device,
    colorMode: j.colorMode,
    totalPages: j.totalPages,
    size: j.size,
    status: j.status,
    createdAt: j.createdAt
  }));

  if (db) {
    try {
      const sumDoc = await db.collection('stats').doc('summary').get();
      if (sumDoc.exists) {
        const d = sumDoc.data();
        summary = {
          totalJobs: d.totalJobs || 0,
          totalPages: d.totalPages || 0,
          colorPages: d.colorPages || 0,
          bwPages: d.bwPages || 0
        };
      }
      const snap = await db.collection('print_jobs').orderBy('timestamp', 'desc').limit(20).get();
      if (!snap.empty) {
        recentJobs = snap.docs.map(doc => {
          const d = doc.data();
          return {
            id: d.jobId || doc.id,
            name: d.name,
            source: d.source,
            device: d.device || d.source,
            colorMode: d.colorMode || 'Color',
            totalPages: d.totalPages || 1,
            size: d.size || 0,
            status: d.status,
            createdAt: d.createdAt
          };
        });
      }
    } catch (err) {
      console.error('[Firestore] Read error:', err.message);
    }
  }

  res.json({
    espOnline,
    espPrinterStatus: espOnline ? espPrinterStatus : 'Offline',
    firestoreEnabled: Boolean(db),
    summary,
    jobs: recentJobs
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Cloud Print Relay listening on port ${PORT}`);
});
