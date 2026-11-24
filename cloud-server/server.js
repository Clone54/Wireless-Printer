const express = require('express');
const multer = require('multer');
const fs = require('fs');
const https = require('https');


function telegramApi(method, bodyObj) {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken) return Promise.resolve(null);
  const payload = JSON.stringify(bodyObj || {});
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/${method}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 8000
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function sendAdminTelegram(job, reasonLabel = 'Approval Required') {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!botToken || !chatId) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; skipping alert.');
    return Promise.resolve(false);
  }
  const appUrl = (process.env.RENDER_EXTERNAL_URL || 'https://wireless-printer.onrender.com').replace(/\/$/, '');
  const text = [
    `🖨️ Print Request (${reasonLabel})`,
    '',
    `👤 User: ${job.userEmail}`,
    `📄 File: ${job.name}`,
    `🎨 Mode: ${job.colorMode} (${job.totalPages} sheet)`,
    `💰 Amount: ${job.costBdt} BDT`,
    '',
    `Tap Approve below or open Admin Dashboard: ${appUrl}`
  ].join('\n');

  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve & Print', callback_data: `approve:${job.id}` },
        { text: '❌ Cancel', callback_data: `cancel:${job.id}` }
      ]]
    }
  }).then(r => {
    if (r && r.ok) {
      console.log(`[Telegram] Admin notified for job ${job.id}`);
      return true;
    }
    console.error('[Telegram] Failed:', r);
    return false;
  });
}

let tgPollOffset = 0;
function startTelegramPoller() {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!botToken || !chatId) return;

  setInterval(async () => {
    try {
      const res = await telegramApi('getUpdates', { offset: tgPollOffset, timeout: 0, allowed_updates: ['callback_query'] });
      if (!res || !res.ok || !Array.isArray(res.result)) return;
      for (const upd of res.result) {
        tgPollOffset = upd.update_id + 1;
        const cb = upd.callback_query;
        if (!cb || !cb.data || !cb.message) continue;
        if (String(cb.message.chat.id) !== chatId) continue;

        const [action, jobId] = String(cb.data).split(':');
        const idx = jobs.findIndex(j => j.id === jobId);
        if (action === 'approve') {
          if (idx === -1) {
            await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Job no longer in active memory.', show_alert: true });
            continue;
          }
          const [job] = jobs.splice(idx, 1);
          job.status = 'queued';
          job.progress = 0;
          jobs.push(job);
          cacheUpsertJob({ id: job.id, status: 'queued' });
          if (db) db.collection('print_jobs').doc(job.id).update({ status: 'queued' }).catch(() => {});
          await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Approved! Printing started.' });
          await telegramApi('editMessageText', {
            chat_id: chatId,
            message_id: cb.message.message_id,
            text: `${cb.message.text}\n\n✅ APPROVED — Queued for printing`
          });
          console.log(`[Telegram] Approved job ${jobId}`);
        } else if (action === 'cancel') {
          if (idx !== -1) {
            jobs[idx].status = 'cancelled';
            cleanupJobFiles(jobs[idx]);
          }
          const cj = dbCache.jobs.find(j => j.id === jobId);
          if (cj) cj.status = 'cancelled';
          if (db) db.collection('print_jobs').doc(jobId).update({ status: 'cancelled' }).catch(() => {});
          await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Job cancelled.' });
          await telegramApi('editMessageText', {
            chat_id: chatId,
            message_id: cb.message.message_id,
            text: `${cb.message.text}\n\n❌ CANCELLED by Admin`
          });
          console.log(`[Telegram] Cancelled job ${jobId}`);
        }
      }
    } catch (e) {}
  }, 4000);
}

function sendAdminBrevoEmail(job) {
  const apiKey = (process.env.BREVO_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('[Brevo] BREVO_API_KEY not set; skipping admin email notification.');
    return Promise.resolve(false);
  }
  const senderEmail = (process.env.BREVO_SENDER_EMAIL || ADMIN_EMAIL).trim();
  const appUrl = (process.env.RENDER_EXTERNAL_URL || 'https://wireless-printer.onrender.com').replace(/\/$/, '');
  const payload = JSON.stringify({
    sender: { name: 'Firoz Cloud Print', email: senderEmail },
    to: [{ email: ADMIN_EMAIL, name: 'Admin' }],
    subject: `[Photo Glossy Request] ${job.name} (${job.costBdt} BDT)`,
    htmlContent: `
      <div style="font-family:system-ui,sans-serif;max-width:520px;padding:16px;border:1px solid #e2e8f0;border-radius:10px;">
        <h2 style="margin:0 0 10px;color:#0f172a;">New Photo Glossy Print Request</h2>
        <p style="margin:6px 0;"><b>User:</b> ${job.userEmail}</p>
        <p style="margin:6px 0;"><b>Document:</b> ${job.name}</p>
        <p style="margin:6px 0;"><b>Mode:</b> ${job.colorMode} (${job.totalPages} sheet)</p>
        <p style="margin:6px 0;"><b>Amount:</b> ${job.costBdt} BDT</p>
        <p style="margin:14px 0 0;">Load Photo Glossy paper into the Epson L3210, then click <b>Start Print</b> on your Admin dashboard:</p>
        <p style="margin:12px 0 0;"><a href="${appUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Open Admin Dashboard</a></p>
      </div>
    `
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 8000
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Brevo] Admin notified for job ${job.id}`);
          resolve(true);
        } else {
          console.error(`[Brevo] Failed (${res.statusCode}):`, body);
          resolve(false);
        }
      });
    });
    req.on('error', (err) => {
      console.error('[Brevo] Request error:', err.message);
      resolve(false);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const PRINT_TOKEN = process.env.PRINT_TOKEN || 'changeme123';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'firozahmedshoykot44@gmail.com').toLowerCase();
let rateColorBdt = 4;
let rateBwBdt = 3;
let queuePaused = false;
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
const dbCache = {
  loaded: false,
  lastAttemptMs: 0,
  rates: { colorBdt: 4, bwBdt: 3 },
  summary: { totalJobs: 0, totalPages: 0, colorPages: 0, bwPages: 0 },
  users: {},
  jobs: []
};

function cacheUpsertJob(jobObj) {
  const idx = dbCache.jobs.findIndex(j => j.id === jobObj.id);
  if (idx >= 0) {
    dbCache.jobs[idx] = { ...dbCache.jobs[idx], ...jobObj };
  } else {
    dbCache.jobs.unshift(jobObj);
    if (dbCache.jobs.length > 100) dbCache.jobs.length = 100;
  }
}

async function ensureDbCacheLoaded() {
  if (!db || dbCache.loaded) return;
  if (Date.now() - dbCache.lastAttemptMs < 300000) return;
  dbCache.lastAttemptMs = Date.now();
  try {
    const [sumDoc, jobsSnap, usersSnap, rateDoc, queueDoc] = await Promise.all([
      db.collection('stats').doc('summary').get(),
      db.collection('print_jobs').orderBy('timestamp', 'desc').limit(100).get(),
      db.collection('users').get(),
      db.collection('settings').doc('pricing').get(),
      db.collection('settings').doc('queue').get()
    ]);
    if (queueDoc.exists) {
      queuePaused = Boolean(queueDoc.data().paused);
    }
    if (rateDoc.exists) {
      const rd = rateDoc.data();
      if (typeof rd.colorBdt === 'number' && rd.colorBdt >= 0) rateColorBdt = rd.colorBdt;
      if (typeof rd.bwBdt === 'number' && rd.bwBdt >= 0) rateBwBdt = rd.bwBdt;
      dbCache.rates = { colorBdt: rateColorBdt, bwBdt: rateBwBdt };
    }

    if (sumDoc.exists) {
      const d = sumDoc.data();
      dbCache.summary = {
        totalJobs: d.totalJobs || 0,
        totalPages: d.totalPages || 0,
        colorPages: d.colorPages || 0,
        bwPages: d.bwPages || 0
      };
    }

    const loadedUsers = {};
    usersSnap.docs.forEach(doc => {
      const u = doc.data();
      const uid = u.uid || doc.id;
      loadedUsers[uid] = { ...u, uid };
    });
    dbCache.users = { ...loadedUsers, ...dbCache.users };

    const activeIds = new Set(jobs.map(j => j.id));
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const loadedJobs = jobsSnap.docs.map(doc => {
      const d = doc.data();
      const jid = d.jobId || doc.id;
      let st = d.status;
      if ((st === 'queued' || st === 'printing') && !activeIds.has(jid)) {
        const ts = d.createdAt ? Date.parse(d.createdAt) : 0;
        if (ts && ts < tenMinAgo) {
          st = 'expired';
          doc.ref.update({ status: 'expired' }).catch(() => {});
        }
      }
      return {
        id: jid,
        uid: d.uid || '',
        userEmail: d.userEmail || '',
        userName: d.userName || '',
        name: d.name,
        source: d.source || 'web',
        device: d.device || d.source,
        colorMode: d.colorMode || 'Color',
        totalPages: d.totalPages || 1,
        costBdt: typeof d.costBdt === 'number'
          ? d.costBdt
          : computeDueBdt(d.colorMode === 'Color' ? (d.totalPages || 1) : 0, d.colorMode === 'B&W' ? (d.totalPages || 1) : 0),
        status: st,
        createdAt: d.createdAt || new Date().toISOString()
      };
    });

    const existingMap = new Map(loadedJobs.map(j => [j.id, j]));
    for (const j of dbCache.jobs) {
      if (!existingMap.has(j.id)) loadedJobs.unshift(j);
    }
    dbCache.jobs = loadedJobs.slice(0, 100);
    dbCache.loaded = true;
    console.log('[Cache] Loaded from Firestore:', dbCache.jobs.length, 'jobs,', Object.keys(dbCache.users).length, 'users');
  } catch (err) {
    console.error('[Cache] Firestore load failed (using RAM fallback):', err.message);
  }
}
let lastEspSeen = 0;
let espPrinterStatus = 'Unknown';
let espWifiSsid = '';

function computeDueBdt(colorPages, bwPages) {
  return (Number(colorPages || 0) * rateColorBdt) + (Number(bwPages || 0) * rateBwBdt);
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

async function getSelectedPageList(filePath, ext, pageMode, customPages) {
  if (ext !== '.pdf') return [1];

  const info = await runFilter('pdfinfo', [filePath], null);
  const match = info.stdout.toString('utf8').match(/Pages:\s+(\d+)/i);
  const totalPdfPages = match ? Math.max(1, parseInt(match[1], 10)) : 1;

  if (pageMode === 'odd') {
    const arr = [];
    for (let p = 1; p <= totalPdfPages; p += 2) arr.push(p);
    return arr;
  }
  if (pageMode === 'even') {
    const arr = [];
    for (let p = 2; p <= totalPdfPages; p += 2) arr.push(p);
    return arr;
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
    return selected.size > 0 ? Array.from(selected).sort((a, b) => a - b) : Array.from({ length: totalPdfPages }, (_, i) => i + 1);
  }
  return Array.from({ length: totalPdfPages }, (_, i) => i + 1);
}


async function detectPdfPageColors(filePath, totalPdfPages) {
  const map = {};
  try {
    const res = await runFilter('gs', ['-q', '-o', '-', '-sDEVICE=inkcov', filePath], null);
    const lines = res.stdout.toString('utf8').split(/\r?\n/).filter(l => l.includes('CMYK'));
    if (lines.length > 0) {
      lines.forEach((line, idx) => {
        const m = line.trim().match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (m) {
          const c = parseFloat(m[1]) || 0;
          const mag = parseFloat(m[2]) || 0;
          const y = parseFloat(m[3]) || 0;
          map[idx + 1] = (c > 0.001 || mag > 0.001 || y > 0.001);
        }
      });
      return map;
    }
  } catch (e) {}
  for (let p = 1; p <= totalPdfPages; p++) map[p] = true;
  return map;
}

async function detectImageIsColor(filePath) {
  try {
    const res = await runFilter('convert', [
      filePath, '-resize', '256x256>', '-colorspace', 'HSL', '-channel', 'S', '-separate', '+channel',
      '-format', '%[fx:maxima]', 'info:'
    ], null);
    const maxSat = parseFloat(res.stdout.toString('utf8').trim());
    if (Number.isFinite(maxSat)) return maxSat > 0.04;
  } catch (e) {}
  return true;
}

async function countSelectedPages(filePath, ext, pageMode, customPages) {
  const list = await getSelectedPageList(filePath, ext, pageMode, customPages);
  return list.length;
}

const PSRAM_CHUNK_THRESHOLD = 6500000; // 6.5 MB threshold (fits safely inside 7 MB ESP32-S3 PSRAM buffer)



const OFFICE_EXTS = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.ods', '.odp', '.txt', '.rtf']);

async function convertOfficeToPdf(inputPath, outDir) {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outPdf = path.join(outDir, `${baseName}.pdf`);
  const res = await runFilter('libreoffice', [
    '--headless', '--norestore', '--nofirststartwizard',
    '-env:UserInstallation=file:///tmp/lo_profile',
    '--convert-to', 'pdf',
    '--outdir', outDir,
    inputPath
  ], null);
  if (fs.existsSync(outPdf)) return outPdf;
  console.error('[LibreOffice] Conversion failed:', res.stderr);
  return null;
}

async function composePresetPdf({ inputPath, ext, backPath, preset, passportCopies = 5, paper, orientation, outPdfPath }) {
  // 300 DPI page dimensions
  const dims300 = {
    A4: [2480, 3508],
    A5: [1748, 2480],
    Letter: [2550, 3300]
  };
  let [pgW, pgH] = dims300[paper] || dims300.A4;
  if (orientation === 'landscape') {
    const tmp = pgW; pgW = pgH; pgH = tmp;
  }

  const tempFiles = [];
  const toPng = async (srcPath, srcExt, pageNum, tag) => {
    if (srcExt === '.pdf') {
      const prefix = `${inputPath}_${tag}`;
      await runFilter('pdftoppm', ['-png', '-r', '300', '-f', String(pageNum), '-l', String(pageNum), srcPath, prefix], null);
      const candidates = fs.readdirSync(path.dirname(prefix)).filter(f => f.startsWith(path.basename(prefix)) && f.endsWith('.png'));
      if (candidates.length > 0) {
        const p = path.join(path.dirname(prefix), candidates[0]);
        tempFiles.push(p);
        return p;
      }
      return null;
    }
    return srcPath;
  };

  try {
    const frontImg = await toPng(inputPath, ext, 1, 'front');
    if (!frontImg) return false;

    if (preset === 'id_card') {
      // Standard CR80 ID card at 300 DPI: 85.6mm x 54mm = 1011 x 638 px
      const cardW = 1011, cardH = 638;
      let backImg = null;
      if (backPath && fs.existsSync(backPath)) {
        const bExt = path.extname(backPath).toLowerCase() || '.png';
        backImg = await toPng(backPath, bExt, 1, 'back');
      } else if (ext === '.pdf') {
        backImg = await toPng(inputPath, ext, 2, 'back2');
      }

      const fCard = `${inputPath}_fcard.png`;
      tempFiles.push(fCard);
      await runFilter('convert', [
        frontImg, '-auto-orient', '-resize', `${cardW}x${cardH}!`,
        '-bordercolor', '#cbd5e1', '-border', '2', fCard
      ], null);

      const args = ['-size', `${pgW}x${pgH}`, 'xc:white'];
      if (backImg && fs.existsSync(backImg)) {
        const bCard = `${inputPath}_bcard.png`;
        tempFiles.push(bCard);
        await runFilter('convert', [
          backImg, '-auto-orient', '-resize', `${cardW}x${cardH}!`,
          '-bordercolor', '#cbd5e1', '-border', '2', bCard
        ], null);

        if (orientation === 'landscape') {
          const gap = 80;
          const x1 = Math.round((pgW - (cardW * 2 + gap)) / 2);
          const x2 = x1 + cardW + gap;
          const y = Math.round((pgH - cardH) / 2);
          args.push(fCard, '-geometry', `+${x1}+${y}`, '-composite');
          args.push(bCard, '-geometry', `+${x2}+${y}`, '-composite');
        } else {
          const gap = 80;
          const x = Math.round((pgW - cardW) / 2);
          const y1 = Math.round((pgH - (cardH * 2 + gap)) / 2);
          const y2 = y1 + cardH + gap;
          args.push(fCard, '-geometry', `+${x}+${y1}`, '-composite');
          args.push(bCard, '-geometry', `+${x}+${y2}`, '-composite');
        }
      } else {
        const x = Math.round((pgW - cardW) / 2);
        const y = Math.round((pgH - cardH) / 2);
        args.push(fCard, '-geometry', `+${x}+${y}`, '-composite');
      }
      const pdfArgs = [...args, '-density', '300', '-units', 'PixelsPerInch', outPdfPath];
      const res = await runFilter('convert', pdfArgs, null);
      if (fs.existsSync(outPdfPath) && res.code === 0) return outPdfPath;
      console.error('[Preset] ID card PDF failed:', res.stderr);
      const outPng = outPdfPath.replace(/\.pdf$/i, '.png');
      const pngRes = await runFilter('convert', [...args, '-density', '300', '-units', 'PixelsPerInch', outPng], null);
      if (fs.existsSync(outPng) && pngRes.code === 0) return outPng;
      console.error('[Preset] ID card PNG failed:', pngRes.stderr);
      return null;
    }

    if (preset === 'passport' || preset === 'passport_4' || preset === 'passport_8') {
      // Row-by-row from top-left: 5 columns x 6 rows on A4 portrait (448x548 px @ 300 DPI)
      const photoW = 448, photoH = 548, gap = 16, margin = 60;
      const count = Math.max(5, Math.min(60, parseInt(passportCopies || '5', 10) || 5));
      const cols = Math.max(1, Math.floor((pgW - 2 * margin + gap) / (photoW + gap)));
      const rowsPerPage = Math.max(1, Math.floor((pgH - 2 * margin + gap) / (photoH + gap)));
      const perPage = cols * rowsPerPage;

      const tile = `${inputPath}_pp.png`;
      tempFiles.push(tile);
      await runFilter('convert', [
        frontImg, '-auto-orient', '-resize', `${photoW}x${photoH}^`,
        '-gravity', 'center', '-extent', `${photoW}x${photoH}`,
        '-bordercolor', '#cbd5e1', '-border', '2', tile
      ], null);

      const numSheets = Math.ceil(count / perPage);
      const sheetPngs = [];
      for (let sh = 0; sh < numSheets; sh++) {
        const startIdx = sh * perPage;
        const endIdx = Math.min(count, startIdx + perPage);
        const sheetPng = `${inputPath}_ppsh${sh}.png`;
        tempFiles.push(sheetPng);
        const args = ['-size', `${pgW}x${pgH}`, 'xc:white'];
        for (let idx = startIdx; idx < endIdx; idx++) {
          const localIdx = idx - startIdx;
          const r = Math.floor(localIdx / cols);
          const c = localIdx % cols;
          const x = margin + c * (photoW + gap);
          const y = margin + r * (photoH + gap);
          args.push(tile, '-geometry', `+${x}+${y}`, '-composite');
        }
        args.push(sheetPng);
        const r1 = await runFilter('convert', args, null);
        if (r1.code !== 0 || !fs.existsSync(sheetPng)) return false;
        sheetPngs.push(sheetPng);
      }

      const res = await runFilter('convert', [...sheetPngs, '-density', '300', '-units', 'PixelsPerInch', outPdfPath], null);
      if (fs.existsSync(outPdfPath) && res.code === 0) return outPdfPath;
      console.error('[Preset] Passport PDF failed:', res.stderr);
      if (sheetPngs.length === 1) {
        const outPng = outPdfPath.replace(/\.pdf$/i, '.png');
        fs.copyFileSync(sheetPngs[0], outPng);
        return outPng;
      }
      return null;
    }
    return false;
  } finally {
    for (const tf of tempFiles) {
      if (fs.existsSync(tf)) fs.unlink(tf, () => {});
    }
  }
}

async function renderEscprBuffer({ inputPath, ext, originalName, paper, cupsOpts, copies, optsStr, envVars }) {
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
  return { finalBuf, diagLog };
}

async function upsertUserOnLogin(user, devInfo) {
  const prevU = dbCache.users[user.uid] || {};
  const isAuth = user.isAdmin ? true : Boolean(prevU.authorized);
  dbCache.users[user.uid] = {
    ...prevU,
    uid: user.uid,
    email: user.email,
    name: user.name,
    role: user.isAdmin ? 'admin' : 'user',
    authorized: isAuth,
    lastDevice: devInfo.device,
    lastIp: devInfo.ip
  };
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
  cacheUpsertJob({
    id: job.id,
    uid: job.uid,
    userEmail: job.userEmail,
    userName: job.userName,
    name: job.name,
    source: job.source,
    device: job.device,
    colorMode: job.colorMode,
    totalPages: job.totalPages,
    costBdt: job.costBdt,
    status: job.status,
    createdAt: job.createdAt
  });
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
  cacheUpsertJob({ id: job.id, status: job.status });
  if (ok) {
    const colorInc = typeof job.colorSheets === 'number' ? job.colorSheets : (job.colorMode === 'Color' ? job.totalPages : 0);
    const bwInc = typeof job.bwSheets === 'number' ? job.bwSheets : (job.colorMode === 'B&W' ? job.totalPages : 0);
    const costInc = typeof job.costBdt === 'number' ? job.costBdt : computeDueBdt(colorInc, bwInc);
    dbCache.summary.totalJobs = (dbCache.summary.totalJobs || 0) + 1;
    dbCache.summary.totalPages = (dbCache.summary.totalPages || 0) + job.totalPages;
    dbCache.summary.colorPages = (dbCache.summary.colorPages || 0) + colorInc;
    dbCache.summary.bwPages = (dbCache.summary.bwPages || 0) + bwInc;

    if (job.uid) {
      if (!memoryUserDues[job.uid]) memoryUserDues[job.uid] = { dueColorPages: 0, dueBwPages: 0 };
      if (job.colorMode === 'Color') memoryUserDues[job.uid].dueColorPages += job.totalPages;
      else memoryUserDues[job.uid].dueBwPages += job.totalPages;

      const u = dbCache.users[job.uid] || { uid: job.uid, email: job.userEmail, name: job.userName };
      u.totalJobs = (u.totalJobs || 0) + 1;
      u.totalPages = (u.totalPages || 0) + job.totalPages;
      u.colorPages = (u.colorPages || 0) + colorInc;
      u.bwPages = (u.bwPages || 0) + bwInc;
      u.dueColorPages = (u.dueColorPages || 0) + colorInc;
      u.dueBwPages = (u.dueBwPages || 0) + bwInc;
      u.dueAmountBdt = resolveUserDueBdt(u) + costInc;
      u.dueResetFlag = true;
      dbCache.users[job.uid] = u;
    }
  }

  if (!db) return;
  try {
    await db.collection('print_jobs').doc(job.id).update({
      status: job.status,
      completedAt: new Date().toISOString()
    });
    if (ok) {
      const inc = admin.firestore.FieldValue.increment;
      const colorInc = typeof job.colorSheets === 'number' ? job.colorSheets : (job.colorMode === 'Color' ? job.totalPages : 0);
      const bwInc = typeof job.bwSheets === 'number' ? job.bwSheets : (job.colorMode === 'B&W' ? job.totalPages : 0);
      const costInc = typeof job.costBdt === 'number' ? job.costBdt : computeDueBdt(colorInc, bwInc);

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
    rates: { colorBdt: rateColorBdt, bwBdt: rateBwBdt }
  });
});

app.post('/api/me', requireGoogleUser, async (req, res) => {
  const devInfo = parseDeviceInfo(req);
  await ensureDbCacheLoaded();
  await upsertUserOnLogin(req.user, devInfo);
  const authorized = req.user.isAdmin || Boolean((dbCache.users[req.user.uid] || {}).authorized);
  res.json({ user: { ...req.user, authorized } });
});





app.post('/api/admin/authorize-user', requireGoogleUser, express.json(), async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only Admin can authorize users' });
  }
  const targetUid = req.body && req.body.uid;
  const authorized = Boolean(req.body && req.body.authorized);
  if (!targetUid) {
    return res.status(400).json({ error: 'Missing user uid' });
  }
  if (!dbCache.users[targetUid]) {
    dbCache.users[targetUid] = { uid: targetUid };
  }
  dbCache.users[targetUid].authorized = authorized;

  if (db) {
    try {
      await db.collection('users').doc(targetUid).set({
        authorized,
        authorizedBy: req.user.email,
        authorizedAt: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      return res.status(500).json({ error: `Failed to update user authorization: ${err.message}` });
    }
  }
  console.log(`[Admin] User ${targetUid} authorized=${authorized} by ${req.user.email}`);
  res.json({ ok: true, uid: targetUid, authorized });
});

app.post('/api/admin/release-job/:id', requireGoogleUser, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only Admin can start Photo Glossy jobs' });
  }
  const jobId = req.params.id;
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Job files are no longer in active memory (server may have restarted). Ask user to re-upload.' });
  }
  const [job] = jobs.splice(idx, 1);
  job.status = 'queued';
  job.progress = 0;
  jobs.push(job);
  cacheUpsertJob({ id: job.id, status: 'queued' });
  if (db) {
    db.collection('print_jobs').doc(job.id).update({ status: 'queued' }).catch(() => {});
  }
  console.log(`[Admin] Released Photo Glossy job ${job.id} into live queue by ${req.user.email}`);
  res.json({ ok: true });
});

app.post('/api/admin/queue-toggle', requireGoogleUser, express.json(), async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only Admin can pause or resume the queue' });
  }
  const nextPaused = (req.body && typeof req.body.paused === 'boolean') ? req.body.paused : !queuePaused;
  queuePaused = nextPaused;
  if (db) {
    try {
      await db.collection('settings').doc('queue').set({
        paused: queuePaused,
        updatedBy: req.user.email,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (err) {}
  }
  console.log(`[Admin] Queue ${queuePaused ? 'PAUSED' : 'RESUMED'} by ${req.user.email}`);
  res.json({ ok: true, queuePaused });
});

app.post('/api/admin/rates', requireGoogleUser, express.json(), async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only Admin can change pricing rates' });
  }
  const c = Number(req.body && req.body.colorBdt);
  const b = Number(req.body && req.body.bwBdt);
  if (!Number.isFinite(c) || !Number.isFinite(b) || c < 0 || b < 0 || c > 500 || b > 500) {
    return res.status(400).json({ error: 'Invalid rates. Enter values between 0 and 500 BDT.' });
  }
  rateColorBdt = Math.round(c * 100) / 100;
  rateBwBdt = Math.round(b * 100) / 100;
  dbCache.rates = { colorBdt: rateColorBdt, bwBdt: rateBwBdt };

  if (db) {
    try {
      await db.collection('settings').doc('pricing').set({
        colorBdt: rateColorBdt,
        bwBdt: rateBwBdt,
        updatedBy: req.user.email,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      return res.status(500).json({ error: `Failed to save rates in Firestore: ${err.message}` });
    }
  }
  console.log(`[Admin] Updated rates: Color=${rateColorBdt} BDT, B&W=${rateBwBdt} BDT by ${req.user.email}`);
  res.json({ ok: true, rates: { colorBdt: rateColorBdt, bwBdt: rateBwBdt } });
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
  if (dbCache.users[targetUid]) {
    dbCache.users[targetUid].dueColorPages = 0;
    dbCache.users[targetUid].dueBwPages = 0;
    dbCache.users[targetUid].dueAmountBdt = 0;
    dbCache.users[targetUid].dueResetFlag = true;
  }

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

app.post('/api/print-file', requireGoogleUser, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'backFile', maxCount: 1 }]), async (req, res) => {
  const mainFile = (req.files && req.files.file && req.files.file[0]) || req.file;
  const backUpload = req.files && req.files.backFile && req.files.backFile[0];
  if (!mainFile) {
    if (backUpload && fs.existsSync(backUpload.path)) fs.unlink(backUpload.path, () => {});
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const originalName = decodeFilename(mainFile.originalname);
  let ext = path.extname(originalName).toLowerCase() || '.pdf';
  let inputPath = `${mainFile.path}${ext}`;
  fs.renameSync(mainFile.path, inputPath);

  let backPath = null;
  if (backUpload) {
    const bExt = path.extname(decodeFilename(backUpload.originalname)).toLowerCase() || '.png';
    backPath = `${backUpload.path}${bExt}`;
    fs.renameSync(backUpload.path, backPath);
  }

  const extraCleanup = [];
  const cleanup = () => {
    if (fs.existsSync(inputPath)) fs.unlink(inputPath, () => {});
    if (backPath && fs.existsSync(backPath)) fs.unlink(backPath, () => {});
    for (const p of extraCleanup) {
      if (fs.existsSync(p)) fs.unlink(p, () => {});
    }
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
  let quality = ['PLAIN_NORMAL', 'PLAIN_HIGH'].includes(req.body.quality)
    ? req.body.quality
    : 'PLAIN_NORMAL';
  const layoutPreset = ['none', 'id_card', 'passport', 'passport_4', 'passport_8'].includes(req.body.layoutPreset)
    ? req.body.layoutPreset
    : 'none';
  const isPassportPreset = (layoutPreset === 'passport' || layoutPreset === 'passport_4' || layoutPreset === 'passport_8');
  const passportCopies = isPassportPreset
    ? Math.max(5, Math.min(60, parseInt(req.body.passportCopies || '5', 10) || 5))
    : 0;
  const passportMedia = (isPassportPreset && req.body.passportMedia === 'PMPHOTO_NORMAL')
    ? 'PMPHOTO_NORMAL'
    : 'PLAIN_NORMAL';
  if (isPassportPreset && passportMedia === 'PMPHOTO_NORMAL') {
    quality = 'PMPHOTO_NORMAL';
  }

  if (OFFICE_EXTS.has(ext)) {
    const convertedPdf = await convertOfficeToPdf(inputPath, JOBS_DIR);
    if (!convertedPdf) {
      cleanup();
      return res.status(500).json({ error: 'Could not convert Office document to PDF.' });
    }
    extraCleanup.push(inputPath);
    inputPath = convertedPdf;
    ext = '.pdf';
  }

  let activePageMode = pageMode;
  let activeCustomPages = customPages;
  let activePagesPerSheet = pagesPerSheet;

  if (layoutPreset !== 'none') {
    const composedPdf = path.join(JOBS_DIR, `${jobId}_preset.pdf`);
    extraCleanup.push(composedPdf);
    const composedPath = await composePresetPdf({
      inputPath, ext, backPath, preset: layoutPreset, passportCopies, paper, orientation, outPdfPath: composedPdf
    });
    if (!composedPath) {
      cleanup();
      return res.status(500).json({ error: 'Failed to compose ID Card / Passport Photo sheet.' });
    }
    extraCleanup.push(inputPath);
    inputPath = composedPath;
    ext = path.extname(composedPath).toLowerCase() || '.pdf';
    activePageMode = 'all';
    activeCustomPages = '';
    activePagesPerSheet = 1;
  }

  const selectedPageList = await getSelectedPageList(inputPath, ext, activePageMode, activeCustomPages);
  const selectedPages = selectedPageList.length;
  if (selectedPages === 0) {
    cleanup();
    return res.status(400).json({ error: 'No pages matched your selected page filter.' });
  }
  const sheetsPerCopy = Math.ceil(selectedPages / activePagesPerSheet);
  const totalPages = sheetsPerCopy * copies;

  // Smart Color Detection: even if user selects Color, colorless sheets are billed & printed as B&W
  const sheetGroupsAll = [];
  for (let i = 0; i < selectedPageList.length; i += activePagesPerSheet) {
    sheetGroupsAll.push(selectedPageList.slice(i, i + activePagesPerSheet));
  }
  if (pageOrder === 'reverse') sheetGroupsAll.reverse();

  let sheetIsColor = sheetGroupsAll.map(() => !isGray);
  if (!isGray) {
    if (ext === '.pdf') {
      const maxP = Math.max(...selectedPageList, 1);
      const pageColorMap = await detectPdfPageColors(inputPath, maxP);
      sheetIsColor = sheetGroupsAll.map(grp => grp.some(p => pageColorMap[p] !== false));
    } else {
      const imgColor = await detectImageIsColor(inputPath);
      sheetIsColor = sheetGroupsAll.map(() => imgColor);
    }
  }

  const colorSheetsPerCopy = sheetIsColor.filter(Boolean).length;
  const bwSheetsPerCopy = sheetIsColor.length - colorSheetsPerCopy;
  const colorSheets = colorSheetsPerCopy * copies;
  const bwSheets = bwSheetsPerCopy * copies;
  const isPhotoGlossyPassport = (isPassportPreset && passportMedia === 'PMPHOTO_NORMAL');
  const photoCountPerSheet = isPassportPreset ? passportCopies : 0;
  const effectiveColorMode = isPhotoGlossyPassport
    ? `Photo Glossy (${passportCopies}×)`
    : ((colorSheets > 0 && bwSheets > 0)
        ? `Mixed (${colorSheets}C+${bwSheets}B)`
        : (colorSheets > 0 ? 'Color' : 'B&W'));
  const effectiveInk = isPhotoGlossyPassport ? 'COLOR' : ((colorSheets === 0) ? 'MONO' : ink);
  const costBdt = isPhotoGlossyPassport
    ? (photoCountPerSheet * copies * 6)
    : computeDueBdt(colorSheets, bwSheets);
  const devInfo = parseDeviceInfo(req);

  const baseCupsOpts = [
    '-o', `PageSize=${paper}`,
    '-o', `media=${paper}`,
    '-o', `Ink=${effectiveInk}`,
    '-o', `MediaType=${quality}`,
    '-o', 'fit-to-page'
  ];
  if (orientation === 'landscape') baseCupsOpts.push('-o', 'landscape');
  if (pageOrder === 'reverse') baseCupsOpts.push('-o', 'outputorder=reverse');
  if (activePagesPerSheet > 1) baseCupsOpts.push('-o', `number-up=${activePagesPerSheet}`);

  const cupsOpts = [...baseCupsOpts];
  if (activePageMode === 'odd') cupsOpts.push('-o', 'page-set=odd');
  else if (activePageMode === 'even') cupsOpts.push('-o', 'page-set=even');
  else if (activePageMode === 'custom' && activeCustomPages) cupsOpts.push('-o', `page-ranges=${activeCustomPages}`);

  const optsStr = `PageSize=${paper} media=${paper} Ink=${ink} MediaType=${quality} fit-to-page`;
  const envVars = { PPD: PPD_PATH, PRINTER: 'epson_l3210', CUPS_SERVERROOT: '/etc/cups' };

  try {
    const { finalBuf, diagLog } = await renderEscprBuffer({
      inputPath, ext, originalName, paper, cupsOpts, copies, optsStr, envVars
    });

    console.log('[CUPS Pipeline]', diagLog);

    if (!isValidEscpr(finalBuf)) {
      cleanup();
      return res.status(500).json({ error: `Safety block (no paper wasted). Diagnostics: ${diagLog}` });
    }

    let chunks = [];
    let totalSize = finalBuf.length;

    // Automatic Threshold-Based Page Chunking:
    // If <= 6.5 MB, keep as 1 single continuous file (zero extra pauses).
    // If > 6.5 MB on a multi-sheet PDF, split into ~3.5 MB sub-chunks so every chunk fits 100% in ESP32-S3 PSRAM!
    const hasMixedRuns = (ext === '.pdf' && colorSheets > 0 && bwSheets > 0 && sheetsPerCopy > 1);
    if (hasMixedRuns || (ext === '.pdf' && finalBuf.length > PSRAM_CHUNK_THRESHOLD && sheetsPerCopy > 1)) {
      const avgSheetBytes = Math.ceil(finalBuf.length / totalPages);
      const maxSheetsPerChunk = Math.max(1, Math.floor(3800000 / Math.max(1, avgSheetBytes)));
      const pagesPerChunk = maxSheetsPerChunk * pagesPerSheet;

      const sheetsPerGroup = Math.max(1, Math.floor(pagesPerChunk / pagesPerSheet));
      const chunkPageBatches = [];
      let curBatch = [];
      let curInk = null;
      for (let i = 0; i < sheetGroupsAll.length; i++) {
        const sInk = sheetIsColor[i] ? 'COLOR' : 'MONO';
        if (curBatch.length > 0 && ((hasMixedRuns && sInk !== curInk) || curBatch.length >= sheetsPerGroup)) {
          chunkPageBatches.push({ groups: curBatch, ink: curInk });
          curBatch = [];
        }
        curInk = sInk;
        curBatch.push(sheetGroupsAll[i]);
      }
      if (curBatch.length > 0) chunkPageBatches.push({ groups: curBatch, ink: curInk });

      totalSize = 0;
      let chunkSuccess = true;
      for (let c = 0; c < copies && chunkSuccess; c++) {
        for (let bIdx = 0; bIdx < chunkPageBatches.length; bIdx++) {
          const batchObj = chunkPageBatches[bIdx];
          const groupSlice = pageOrder === 'reverse' ? [...batchObj.groups].reverse() : batchObj.groups;
          const flatPages = [];
          for (const g of groupSlice) {
            for (const p of g) flatPages.push(p);
          }
          flatPages.sort((a, b) => a - b);
          const rangeSpec = flatPages.join(',');
          const chunkInk = batchObj.ink || effectiveInk;
          const chunkOpts = [
            '-o', `PageSize=${paper}`,
            '-o', `media=${paper}`,
            '-o', `Ink=${chunkInk}`,
            '-o', `MediaType=${quality}`,
            '-o', 'fit-to-page'
          ];
          if (orientation === 'landscape') chunkOpts.push('-o', 'landscape');
          if (pageOrder === 'reverse') chunkOpts.push('-o', 'outputorder=reverse');
          if (pagesPerSheet > 1) chunkOpts.push('-o', `number-up=${pagesPerSheet}`);
          chunkOpts.push('-o', `page-ranges=${rangeSpec}`);
          const chunkOptsStr = `PageSize=${paper} media=${paper} Ink=${chunkInk} MediaType=${quality} fit-to-page`;
          const cRes = await renderEscprBuffer({
            inputPath, ext, originalName, paper, cupsOpts: chunkOpts, copies: 1, optsStr: chunkOptsStr, envVars
          });
          if (!isValidEscpr(cRes.finalBuf)) {
            chunkSuccess = false;
            break;
          }
          const cIdx = chunks.length;
          const cPath = path.join(JOBS_DIR, `${jobId}_c${cIdx}.prn`);
          fs.writeFileSync(cPath, cRes.finalBuf);
          chunks.push({ index: cIdx, filePath: cPath, size: cRes.finalBuf.length });
          totalSize += cRes.finalBuf.length;
        }
      }

      if (!chunkSuccess || chunks.length === 0) {
        for (const ch of chunks) {
          if (fs.existsSync(ch.filePath)) fs.unlink(ch.filePath, () => {});
        }
        chunks = [];
        fs.writeFileSync(outPath, finalBuf);
        chunks.push({ index: 0, filePath: outPath, size: finalBuf.length });
        totalSize = finalBuf.length;
      } else {
        console.log(`[Chunker] Split large job ${jobId} (${(finalBuf.length / 1048576).toFixed(2)} MB) into ${chunks.length} PSRAM-safe chunks`);
      }
    } else {
      fs.writeFileSync(outPath, finalBuf);
      chunks.push({ index: 0, filePath: outPath, size: finalBuf.length });
    }

    cleanup();

    const job = {
      id: jobId,
      uid: req.user.uid,
      userEmail: req.user.email,
      userName: req.user.name,
      name: originalName,
      source: 'Web/Phone',
      device: devInfo.device,
      ip: devInfo.ip,
      colorMode: effectiveColorMode,
      colorSheets,
      bwSheets,
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
      size: totalSize,
      chunks,
      currentChunk: 0,
      status: (isPhotoGlossyPassport || !(req.user.isAdmin || Boolean((dbCache.users[req.user.uid] || {}).authorized))) ? 'awaiting_admin' : 'queued',
      createdAt: new Date().toISOString(),
      filePath: chunks[0].filePath
    };
    const needsAdminApproval = (job.status === 'awaiting_admin');
    jobs.push(job);
    await saveJobToFirestore(job);
    if (needsAdminApproval) {
      const reason = isPhotoGlossyPassport ? 'Photo Glossy' : 'Unauthorized User';
      sendAdminTelegram(job, reason).catch(() => {});
      sendAdminBrevoEmail(job).catch(() => {});
    }
    console.log(`[Queue] Job ${jobId} (${job.status}) by ${req.user.email} (${totalPages}p ${effectiveColorMode}, ${costBdt} BDT, ${chunks.length} chunk(s))`);
    return res.json({ ok: true, awaitingAdmin: needsAdminApproval, awaitingReason: isPhotoGlossyPassport ? 'photo_glossy' : (needsAdminApproval ? 'unauthorized' : null), job: { id: job.id, name: job.name, size: job.size, totalPages, colorSheets, bwSheets, colorMode: effectiveColorMode, costBdt, status: job.status } });
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
    costBdt: rateColorBdt,
    paper: 'A4',
    orientation: 'portrait',
    quality: 'Driver',
    pageMode: 'all',
    customPages: '',
    size: req.body.length,
    chunks: [{ index: 0, filePath: outPath, size: req.body.length }],
    currentChunk: 0,
    status: 'queued',
    createdAt: new Date().toISOString(),
    filePath: outPath
  };
  jobs.push(job);
  await saveJobToFirestore(job);
  res.json({ ok: true, jobId, size: job.size });
});

function cleanupJobFiles(job) {
  if (Array.isArray(job.chunks)) {
    for (const ch of job.chunks) {
      if (ch.filePath && fs.existsSync(ch.filePath)) fs.unlink(ch.filePath, () => {});
    }
  }
  if (job.filePath && fs.existsSync(job.filePath)) fs.unlink(job.filePath, () => {});
}

function parseEspJobToken(rawId) {
  const m = String(rawId || '').match(/^([a-f0-9]+?)(?:_c(\d+))?$/i);
  if (!m) return { baseId: String(rawId || ''), chunkIdx: null };
  return { baseId: m[1], chunkIdx: m[2] !== undefined ? parseInt(m[2], 10) : null };
}

// Auto-recover jobs stuck in 'printing' > 2 minutes without stream activity
function recoverStuckJobs() {
  const now = Date.now();
  for (const j of jobs) {
    if (j.status === 'printing' && j.printingAt && (now - j.printingAt > 120000)) {
      j.retries = (j.retries || 0) + 1;
      const curChunk = (Array.isArray(j.chunks) && j.chunks[j.currentChunk || 0]) || { filePath: j.filePath };
      if (j.retries <= 2 && curChunk.filePath && fs.existsSync(curChunk.filePath)) {
        j.status = 'queued';
        console.log(`[Queue] Re-queued stalled job ${j.id} chunk ${j.currentChunk || 0} (retry ${j.retries})`);
      } else {
        j.status = 'failed';
        cleanupJobFiles(j);
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
    cleanupJobFiles(memJob);
  }
  const cachedJob = dbCache.jobs.find(j => j.id === jobId);
  if (cachedJob) {
    if (!req.user.isAdmin && cachedJob.uid !== req.user.uid) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    cachedJob.status = 'cancelled';
  }
  if (db) {
    db.collection('print_jobs').doc(jobId).update({ status: 'cancelled' }).catch(() => {});
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
      const { baseId, chunkIdx } = parseEspJobToken(req.query.jobId);
      const activeJob = jobs.find(j => j.id === baseId && j.status === 'printing');
      if (activeJob) {
        const totalChunks = Array.isArray(activeJob.chunks) && activeJob.chunks.length > 0 ? activeJob.chunks.length : 1;
        const cIdx = chunkIdx !== null ? chunkIdx : (activeJob.currentChunk || 0);
        const rawPct = Math.min(99, Math.max(0, parseInt(req.query.pct, 10) || 0));
        const overallPct = Math.min(99, Math.round(((cIdx * 100) + rawPct) / totalChunks));
        activeJob.progress = overallPct;
        activeJob.printingAt = Date.now();
      }
    }
    return res.status(204).end();
  }
  recoverStuckJobs();
  if (queuePaused) return res.status(204).end();
  const nextJob = jobs.find(j => j.status === 'queued');
  if (!nextJob) return res.status(204).end();

  const totalChunks = Array.isArray(nextJob.chunks) && nextJob.chunks.length > 0 ? nextJob.chunks.length : 1;
  const cIdx = nextJob.currentChunk || 0;
  const curChunk = (Array.isArray(nextJob.chunks) && nextJob.chunks[cIdx]) || { filePath: nextJob.filePath, size: nextJob.size };

  nextJob.status = 'printing';
  if (cIdx === 0) nextJob.progress = 0;
  nextJob.printingAt = Date.now();
  cacheUpsertJob({ id: nextJob.id, status: 'printing' });
  if (db && cIdx === 0) {
    db.collection('print_jobs').doc(nextJob.id).update({ status: 'printing' }).catch(() => {});
  }

  const espJobId = totalChunks > 1 ? `${nextJob.id}_c${cIdx}` : nextJob.id;
  res.json({ id: espJobId, size: curChunk.size, name: nextJob.name });
});

app.get('/api/esp/job/:id', requireDeviceToken, (req, res) => {
  lastEspSeen = Date.now();
  const { baseId, chunkIdx } = parseEspJobToken(req.params.id);
  const job = jobs.find(j => j.id === baseId);
  if (!job) return res.status(404).end();
  const cIdx = chunkIdx !== null ? chunkIdx : (job.currentChunk || 0);
  const curChunk = (Array.isArray(job.chunks) && job.chunks[cIdx]) || { filePath: job.filePath, size: job.size };
  if (!curChunk.filePath || !fs.existsSync(curChunk.filePath)) return res.status(404).end();

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', curChunk.size);
  const stream = fs.createReadStream(curChunk.filePath);
  stream.on('data', () => { lastEspSeen = Date.now(); job.printingAt = Date.now(); });
  stream.pipe(res);
});

app.post('/api/esp/job/:id/done', requireDeviceToken, express.json(), async (req, res) => {
  lastEspSeen = Date.now();
  const { baseId, chunkIdx } = parseEspJobToken(req.params.id);
  const job = jobs.find(j => j.id === baseId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const ok = !req.body || req.body.ok !== false;

  const totalChunks = Array.isArray(job.chunks) && job.chunks.length > 0 ? job.chunks.length : 1;
  const cIdx = chunkIdx !== null ? chunkIdx : (job.currentChunk || 0);
  const curChunk = Array.isArray(job.chunks) && job.chunks[cIdx];
  if (curChunk && curChunk.filePath && fs.existsSync(curChunk.filePath)) {
    fs.unlink(curChunk.filePath, () => {});
  }

  if (ok && (cIdx + 1) < totalChunks) {
    job.currentChunk = cIdx + 1;
    job.status = 'queued';
    job.retries = 0;
    job.progress = Math.min(99, Math.round(((cIdx + 1) * 100) / totalChunks));
    job.printingAt = Date.now();
    console.log(`[Chunker] Job ${job.id} chunk ${cIdx + 1}/${totalChunks} done (${job.progress}%), queued next chunk`);
    return res.json({ ok: true, nextChunk: job.currentChunk });
  }

  job.status = ok ? 'completed' : 'failed';
  job.progress = ok ? 100 : (job.progress || 0);
  cleanupJobFiles(job);
  await updateJobStatusInFirestore(job, ok);
  res.json({ ok: true });
});

function resolveUserDueBdt(u) {
  if (typeof u.dueAmountBdt === 'number') return u.dueAmountBdt;
  if (u.dueResetFlag) return computeDueBdt(u.dueColorPages || 0, u.dueBwPages || 0);
  return computeDueBdt(u.colorPages || 0, u.bwPages || 0);
}

function getRemainingJobPages(j) {
  const totalP = Math.max(1, Number(j.totalPages || 1));
  const isActive = j.status === 'printing' || (j.status === 'queued' && (j.currentChunk || 0) > 0);
  if (!isActive) return totalP;
  const pct = Math.min(99, Math.max(0, Number(j.progress || 0)));
  const donePages = Math.min(totalP - 1, Math.floor((pct * totalP) / 100));
  return Math.max(1, totalP - donePages);
}

function getJobQueueMeta(jobId, status) {
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) {
    return { status, progress: status === 'completed' ? 100 : 0, waitingPages: 0 };
  }
  const mem = jobs[idx];
  const isMidChunk = mem.status === 'queued' && (mem.currentChunk || 0) > 0;
  const uiStatus = isMidChunk ? 'printing' : mem.status;
  const totalP = Math.max(1, Number(mem.totalPages || 1));
  const pct = uiStatus === 'completed' ? 100 : Math.min(99, Math.max(0, Number(mem.progress || 0)));
  const currentPage = uiStatus === 'completed'
    ? totalP
    : Math.min(totalP, Math.floor((pct * totalP) / 100) + 1);

  let waitingPages = 0;
  if (uiStatus === 'queued') {
    for (let i = 0; i < idx; i++) {
      if (jobs[i].status === 'printing' || jobs[i].status === 'queued') {
        waitingPages += getRemainingJobPages(jobs[i]);
      }
    }
  }
  return {
    status: uiStatus,
    progress: pct,
    currentPage,
    waitingPages
  };
}

app.get('/api/status', requireGoogleUser, async (req, res) => {
  const espOnline = (Date.now() - lastEspSeen) < 15000;
  const isAdmin = req.user.isAdmin;

  await ensureDbCacheLoaded();

  let summary = { totalJobs: 0, totalPages: 0, colorPages: 0, bwPages: 0, dueAmountBdt: 0 };
  let recentJobs = [];
  let allUsers = [];

  if (dbCache.loaded || Object.keys(dbCache.users).length > 0 || dbCache.jobs.length > 0) {
    const activeIds = new Set(jobs.map(j => j.id));
    const tenMinAgo = Date.now() - 10 * 60 * 1000;

    if (isAdmin) {
      summary.totalJobs = dbCache.summary.totalJobs || 0;
      summary.totalPages = dbCache.summary.totalPages || 0;
      summary.colorPages = dbCache.summary.colorPages || 0;
      summary.bwPages = dbCache.summary.bwPages || 0;

      recentJobs = dbCache.jobs.slice(0, 30).map(d => {
        let st = d.status;
        if ((st === 'queued' || st === 'printing') && !activeIds.has(d.id)) {
          const ts = d.createdAt ? Date.parse(d.createdAt) : 0;
          if (ts && ts < tenMinAgo) {
            st = 'expired';
            d.status = 'expired';
            if (db) db.collection('print_jobs').doc(d.id).update({ status: 'expired' }).catch(() => {});
          }
        }
        return {
          id: d.id,
          name: d.name,
          userEmail: d.userEmail || '',
          device: d.device || d.source,
          colorMode: d.colorMode || 'Color',
          totalPages: d.totalPages || 1,
          costBdt: typeof d.costBdt === 'number'
            ? d.costBdt
            : computeDueBdt(d.colorMode === 'Color' ? (d.totalPages || 1) : 0, d.colorMode === 'B&W' ? (d.totalPages || 1) : 0),
          status: st,
          ...getJobQueueMeta(d.id, st),
          createdAt: d.createdAt
        };
      });

      let totalUnpaidBdt = 0;
      allUsers = Object.values(dbCache.users).map(u => {
        const dueBdt = resolveUserDueBdt(u);
        totalUnpaidBdt += dueBdt;
        return {
          uid: u.uid,
          email: u.email || '',
          name: u.name || '',
          role: u.role || 'user',
          authorized: (u.role === 'admin') || Boolean(u.authorized),
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
      const u = dbCache.users[req.user.uid];
      if (u) {
        summary = {
          totalJobs: u.totalJobs || 0,
          totalPages: u.totalPages || 0,
          colorPages: u.colorPages || 0,
          bwPages: u.bwPages || 0,
          dueAmountBdt: resolveUserDueBdt(u)
        };
      }
      recentJobs = dbCache.jobs
        .filter(d => d.uid === req.user.uid)
        .slice(0, 20)
        .map(d => ({
          id: d.id,
          name: d.name,
          colorMode: d.colorMode || 'Color',
          totalPages: d.totalPages || 1,
          costBdt: typeof d.costBdt === 'number'
            ? d.costBdt
            : computeDueBdt(d.colorMode === 'Color' ? (d.totalPages || 1) : 0, d.colorMode === 'B&W' ? (d.totalPages || 1) : 0),
          status: d.status,
          ...getJobQueueMeta(d.id, d.status),
          createdAt: d.createdAt
        }));
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
    queuePaused,
    espPrinterStatus: espOnline ? espPrinterStatus : 'Offline',
    espWifiSsid: (isAdmin && espOnline) ? espWifiSsid : undefined,
    user: { ...req.user, authorized: req.user.isAdmin || Boolean((dbCache.users[req.user.uid] || {}).authorized) },
    rates: { colorBdt: rateColorBdt, bwBdt: rateBwBdt },
    summary,
    jobs: recentJobs,
    allUsers: isAdmin ? allUsers : []
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Cloud Print Relay listening on port ${PORT}`);
  ensureDbCacheLoaded();
  startTelegramPoller();
});
