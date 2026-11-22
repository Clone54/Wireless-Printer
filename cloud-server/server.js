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
  limits: { fileSize: 25 * 1024 * 1024 }
});

const jobs = [];
let lastEspSeen = 0;
let espPrinterStatus = 'Unknown';

function requireToken(req, res, next) {
  const token = req.headers['x-print-token'] || req.query.token || (req.body && req.body.token);
  if (!token || token !== PRINT_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing print token' });
  }
  next();
}

// Verify that buffer contains genuine Epson ESC/P-R commands (never PDF, PostScript, or CUPS Raster)
function isValidEscpr(buf) {
  if (!buf || buf.length < 32) return false;
  const head = buf.slice(0, 8).toString('latin1');
  if (head.startsWith('%PDF-') || head.startsWith('%!PS') || head.startsWith('3SaR') || head.startsWith('RaS3') || head.startsWith('2SaR') || head.startsWith('RaS2')) {
    return false;
  }
  const sample = buf.slice(0, Math.min(buf.length, 4096)).toString('latin1');
  return sample.includes('ESCPR') || sample.includes('@EJL') || sample.includes('REMOTE1');
}

app.use(express.static(path.join(__dirname, 'public')));

// Phone / Web UI: upload PDF or image -> CUPS Raster -> epson-escpr-wrapper -> ESC/P-R
app.post('/api/print-file', upload.single('file'), requireToken, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!fs.existsSync(PPD_PATH)) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: 'Epson PPD not initialized in CUPS' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const rasterPath = path.join(JOBS_DIR, `${jobId}.ras`);
  const outPath = path.join(JOBS_DIR, `${jobId}.prn`);
  const paper = req.body.paper === 'Letter' ? 'Letter' : 'A4';
  // Epson ESC/P-R PPD uses Ink=COLOR or Ink=MONO
  const ink = (req.body.color === 'Gray' || req.body.color === 'MONO') ? 'MONO' : 'COLOR';
  const copies = Math.max(1, Math.min(20, parseInt(req.body.copies || '1', 10) || 1));
  const optsStr = `PageSize=${paper} media=${paper} Ink=${ink} MediaType=PLAIN_NORMAL fit-to-page`;

  // Stage 1: try direct cupsfilter -e -> printer/epson_l3210
  const directArgs = [
    '-e',
    '-p', PPD_PATH,
    '-m', 'printer/epson_l3210',
    '-o', `PageSize=${paper}`,
    '-o', `media=${paper}`,
    '-o', `Ink=${ink}`,
    '-o', 'MediaType=PLAIN_NORMAL',
    '-o', `copies=${copies}`,
    '-o', 'fit-to-page',
    req.file.path
  ];

  function finalizeJob(prnBuf) {
    fs.unlink(req.file.path, () => {});
    fs.unlink(rasterPath, () => {});

    if (!isValidEscpr(prnBuf)) {
      const preview = prnBuf ? prnBuf.slice(0, 32).toString('latin1') : 'empty';
      console.error('[CUPS] Rejected non-ESC/P-R output. Header:', JSON.stringify(preview));
      return res.status(500).json({
        error: 'Safety block: output was not valid Epson ESC/P-R data (printer will not waste paper).'
      });
    }

    fs.writeFileSync(outPath, prnBuf);
    const job = {
      id: jobId,
      name: req.file.originalname || 'Document',
      source: 'Web/Phone',
      size: prnBuf.length,
      status: 'queued',
      createdAt: new Date().toISOString(),
      filePath: outPath
    };
    jobs.push(job);
    console.log(`[Queue] Verified ESC/P-R job ${jobId} (${job.name}, ${job.size} bytes)`);
    return res.json({ ok: true, job: { id: job.id, name: job.name, size: job.size, status: job.status } });
  }

  execFile('cupsfilter', directArgs, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (!err && isValidEscpr(stdout)) {
      return finalizeJob(stdout);
    }

    // Stage 2 Fallback: render to CUPS Raster first, then invoke /usr/lib/cups/filter/epson-escpr-wrapper directly
    console.log('[CUPS] Direct cupsfilter did not produce ESC/P-R, running 2-step raster -> epson-escpr-wrapper...');
    const rasterArgs = [
      '-p', PPD_PATH,
      '-m', 'application/vnd.cups-raster',
      '-o', `PageSize=${paper}`,
      '-o', `media=${paper}`,
      '-o', `Ink=${ink}`,
      '-o', 'MediaType=PLAIN_NORMAL',
      '-o', 'fit-to-page',
      req.file.path
    ];

    execFile('cupsfilter', rasterArgs, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (rErr, rOut, rStderr) => {
      if (rErr || !rOut || rOut.length === 0) {
        fs.unlink(req.file.path, () => {});
        console.error('[CUPS] Raster conversion failed:', rErr?.message, rStderr?.toString());
        return res.status(500).json({ error: 'Failed to rasterize file in CUPS' });
      }

      fs.writeFileSync(rasterPath, rOut);
      const wrapperBin = '/usr/lib/cups/filter/epson-escpr-wrapper';
      const wrapperArgs = ['1', 'root', req.file.originalname || 'Job', String(copies), optsStr, rasterPath];

      execFile(
        wrapperBin,
        wrapperArgs,
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PPD: PPD_PATH } },
        (wErr, wOut, wStderr) => {
          if (wErr) {
            console.error('[CUPS] epson-escpr-wrapper error:', wErr?.message, wStderr?.toString());
          }
          return finalizeJob(wOut);
        }
      );
    });
  });
});

// Laptop Relay: receive pre-rendered raw ESC/P-R bytes from Windows/Mac driver
app.post('/api/print-raw', requireToken, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'Empty print payload' });
  }
  if (!isValidEscpr(req.body)) {
    return res.status(400).json({ error: 'Rejected: payload is not valid Epson ESC/P-R data' });
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
