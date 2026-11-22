const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const PRINT_TOKEN = process.env.PRINT_TOKEN || 'changeme123';
const PPD_PATH = '/etc/cups/ppd/epson_l3210.ppd';
const JOBS_DIR = '/tmp/jobs';
const UPLOADS_DIR = '/tmp/uploads';

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB max
});

const jobs = []; // { id, name, source, size, status, createdAt, filePath, error }
let lastEspSeen = 0;
let espPrinterStatus = 'Unknown';

function requireToken(req, res, next) {
  const token = req.headers['x-print-token'] || req.query.token || (req.body && req.body.token);
  if (!token || token !== PRINT_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing print token' });
  }
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

// Phone / Web UI: upload PDF or image and convert via CUPS -> Epson ESC/P-R
app.post('/api/print-file', upload.single('file'), requireToken, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!fs.existsSync(PPD_PATH)) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: 'Epson PPD not initialized in CUPS' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const outPath = path.join(JOBS_DIR, `${jobId}.prn`);
  const paper = req.body.paper === 'Letter' ? 'Letter' : 'A4';
  const color = req.body.color === 'Gray' ? 'Gray' : 'RGB';
  const copies = Math.max(1, Math.min(20, parseInt(req.body.copies || '1', 10) || 1));

  const args = [
    '-p', PPD_PATH,
    '-o', `PageSize=${paper}`,
    '-o', `media=${paper}`,
    '-o', `ColorModel=${color}`,
    '-o', `copies=${copies}`,
    '-o', 'fit-to-page',
    req.file.path
  ];

  execFile('cupsfilter', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    fs.unlink(req.file.path, () => {});

    if (err || !stdout || stdout.length === 0) {
      console.error('[CUPS] cupsfilter error:', err?.message, stderr?.toString());
      return res.status(500).json({ error: 'Failed to convert file for Epson L3210' });
    }

    fs.writeFileSync(outPath, stdout);
    const job = {
      id: jobId,
      name: req.file.originalname || 'Document',
      source: 'Web/Phone',
      size: stdout.length,
      status: 'queued',
      createdAt: new Date().toISOString(),
      filePath: outPath
    };
    jobs.push(job);
    console.log(`[Queue] Added web job ${jobId} (${job.name}, ${job.size} bytes)`);
    res.json({ ok: true, job: { id: job.id, name: job.name, size: job.size, status: job.status } });
  });
});

// Laptop Relay: receive pre-rendered raw ESC/P-R bytes from Windows/Mac driver
app.post('/api/print-raw', requireToken, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'Empty print payload' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const outPath = path.join(JOBS_DIR, `${jobId}.prn`);
  fs.writeFileSync(outPath, req.body);

  const job = {
    id: jobId,
    name: req.headers['x-job-name'] || `Laptop Job ${jobId}`,
    source: 'Laptop',
    size: req.body.length,
    status: 'queued',
    createdAt: new Date().toISOString(),
    filePath: outPath
  };
  jobs.push(job);
  console.log(`[Queue] Added raw job ${jobId} (${job.size} bytes)`);
  res.json({ ok: true, jobId, size: job.size });
});

// ESP32-S3: poll for next queued job
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

// ESP32-S3: stream raw .prn bytes
app.get('/api/esp/job/:id', requireToken, (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);
  if (!job || !fs.existsSync(job.filePath)) {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', job.size);
  fs.createReadStream(job.filePath).pipe(res);
});

// ESP32-S3: mark job complete or failed
app.post('/api/esp/job/:id/done', requireToken, express.json(), (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const ok = !req.body || req.body.ok !== false;
  job.status = ok ? 'completed' : 'failed';
  if (fs.existsSync(job.filePath)) {
    fs.unlink(job.filePath, () => {});
  }
  console.log(`[Queue] Job ${job.id} -> ${job.status}`);
  res.json({ ok: true });
});

// Web UI: status & recent jobs
app.get('/api/status', requireToken, (req, res) => {
  const espOnline = (Date.now() - lastEspSeen) < 15000;
  res.json({
    espOnline,
    espPrinterStatus: espOnline ? espPrinterStatus : 'Offline',
    jobs: jobs.slice(-15).reverse().map(j => ({
      id: j.id,
      name: j.name,
      source: j.source,
      size: j.size,
      status: j.status,
      createdAt: j.createdAt
    }))
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Cloud Print Relay listening on port ${PORT}`);
});
