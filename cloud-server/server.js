const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

function describeHeader(buf) {
  if (!buf || buf.length === 0) return 'EMPTY (0 bytes)';
  const ascii = buf.slice(0, 24).toString('latin1').replace(/[^ -~]/g, '.');
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

app.use(express.static(path.join(__dirname, 'public')));

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
  const ink = (req.body.color === 'Gray' || req.body.color === 'MONO') ? 'MONO' : 'COLOR';
  const copies = Math.max(1, Math.min(20, parseInt(req.body.copies || '1', 10) || 1));
  const optsStr = `PageSize=${paper} media=${paper} Ink=${ink} MediaType=PLAIN_NORMAL fit-to-page`;

  try {
    // Attempt 1: cupsfilter -e -p PPD -m printer/foo
    const a1 = await runFilter('cupsfilter', [
      '-e',
      '-p', PPD_PATH,
      '-d', 'epson_l3210',
      '-m', 'printer/foo',
      '-o', `PageSize=${paper}`,
      '-o', `media=${paper}`,
      '-o', `Ink=${ink}`,
      '-o', 'MediaType=PLAIN_NORMAL',
      '-o', `copies=${copies}`,
      '-o', 'fit-to-page',
      inputPath
    ], null, { PPD: PPD_PATH, PRINTER: 'epson_l3210', CUPS_SERVERROOT: '/etc/cups' });

    let finalBuf = a1.stdout;
    let diagLog = `A1(cupsfilter -e): ${describeHeader(a1.stdout)} err=[${a1.stderr.trim()}]`;

    // Attempt 2: 2-stage pipeline (cupsfilter -> application/vnd.cups-raster -> pipe to epson-escpr-wrapper via stdin)
    if (!isValidEscpr(finalBuf)) {
      const a2Ras = await runFilter('cupsfilter', [
        '-p', PPD_PATH,
        '-m', 'application/vnd.cups-raster',
        '-o', `PageSize=${paper}`,
        '-o', `media=${paper}`,
        '-o', `Ink=${ink}`,
        '-o', 'MediaType=PLAIN_NORMAL',
        '-o', 'fit-to-page',
        inputPath
      ], null, { PPD: PPD_PATH, PRINTER: 'epson_l3210', CUPS_SERVERROOT: '/etc/cups' });

      diagLog += ` | A2-Raster: ${describeHeader(a2Ras.stdout)}`;

      let rasterBuf = a2Ras.stdout;

      // Attempt 3: Ghostscript direct PDF/Image -> CUPS Raster at 360x360 DPI
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
        ], null, { PPD: PPD_PATH, PRINTER: 'epson_l3210', CUPS_SERVERROOT: '/etc/cups' });
        if (pdfPath !== inputPath) fs.unlink(pdfPath, () => {});
        rasterBuf = gsRas.stdout;
        diagLog += ` | A3-GS-Raster: ${describeHeader(rasterBuf)} err=[${gsRas.stderr.trim()}]`;
      }

      if (rasterBuf && rasterBuf.length >= 64) {
        // Pipe CUPS Raster via STDIN (fd 0) to epson-escpr-wrapper (5 args = read from stdin)
        const wrapRes = await runFilter(
          '/usr/lib/cups/filter/epson-escpr-wrapper',
          ['1', 'root', req.file.originalname || 'Job', String(copies), optsStr],
          rasterBuf,
          { PPD: PPD_PATH, PRINTER: 'epson_l3210', CUPS_SERVERROOT: '/etc/cups' }
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
      size: finalBuf.length,
      status: 'queued',
      createdAt: new Date().toISOString(),
      filePath: outPath
    };
    jobs.push(job);
    console.log(`[Queue] Verified ESC/P-R job ${jobId} (${job.name}, ${job.size} bytes)`);
    return res.json({ ok: true, job: { id: job.id, name: job.name, size: job.size, status: job.status } });
  } catch (e) {
    cleanup();
    return res.status(500).json({ error: `Conversion exception: ${e.message}` });
  }
});

// Laptop Relay: receive pre-rendered raw ESC/P-R bytes from Windows/Mac driver
app.post('/api/print-raw', requireToken, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'Empty print payload' });
  }
  if (!isValidEscpr(req.body)) {
    return res.status(400).json({ error: `Rejected non-ESC/P-R payload: ${describeHeader(req.body)}` });
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
