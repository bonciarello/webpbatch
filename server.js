'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const sharp = require('sharp');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4601;
const HOST = '0.0.0.0';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const MAX_FILES = 20;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minuti
const FILE_TTL = 60 * 60 * 1000; // 1 ora

// ── Ensure directories ──────────────────────────────────────────────────────
[UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Express & HTTP server ───────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// ── Multer ──────────────────────────────────────────────────────────────────
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const isWebp = file.mimetype === 'image/webp' ||
                   file.originalname.toLowerCase().endsWith('.webp');
    if (isWebp) {
      cb(null, true);
    } else {
      cb(new Error(`File non supportato: "${file.originalname}". Solo file .webp sono accettati.`));
    }
  }
});

// ── In-memory job store ─────────────────────────────────────────────────────
/** @type {Map<string, {id:string, sessionId:string, originalName:string, status:'waiting'|'processing'|'completed'|'error', error:string|null, webpPath:string, pngPath:string|null, createdAt:number, startedAt:number|null, completedAt:number|null, size:number}>} */
const jobs = new Map();
let processing = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateId() {
  return crypto.randomBytes(10).toString('hex');
}

function sanitizeJob(job) {
  return {
    id: job.id,
    sessionId: job.sessionId,
    originalName: job.originalName,
    status: job.status,
    error: job.error || null,
    createdAt: job.createdAt,
    size: job.size
  };
}

function getSessionJobs(sessionId) {
  const result = [];
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId) {
      result.push(job);
    }
  }
  // Sort by creation time (oldest first)
  result.sort((a, b) => a.createdAt - b.createdAt);
  return result;
}

// ── WebSocket broadcast ─────────────────────────────────────────────────────

function broadcastToSession(sessionId, data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client._sessionId === sessionId) {
      client.send(payload);
    }
  });
}

function broadcastAll(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

// ── Queue processor ─────────────────────────────────────────────────────────

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (true) {
      // Find first waiting job (FIFO)
      let nextJob = null;
      for (const job of jobs.values()) {
        if (job.status === 'waiting') {
          nextJob = job;
          break;
        }
      }
      if (!nextJob) break;

      // Mark as processing
      nextJob.status = 'processing';
      nextJob.startedAt = Date.now();
      broadcastToSession(nextJob.sessionId, { type: 'jobUpdate', job: sanitizeJob(nextJob) });

      try {
        // Validate it's actually a WebP
        let metadata;
        try {
          metadata = await sharp(nextJob.webpPath).metadata();
        } catch (_e) {
          throw new Error('Il file non è un\'immagine WebP valida o è corrotto.');
        }

        if (metadata.format !== 'webp') {
          throw new Error(`Formato rilevato: "${metadata.format}". Solo WebP è supportato.`);
        }

        // Convert to PNG
        const outputPath = path.join(OUTPUTS_DIR, `${nextJob.id}.png`);
        await sharp(nextJob.webpPath)
          .png({ compressionLevel: 6 })
          .toFile(outputPath);

        nextJob.status = 'completed';
        nextJob.pngPath = outputPath;
        nextJob.completedAt = Date.now();

        // Clean up source WebP
        fs.unlink(nextJob.webpPath, () => {});
      } catch (err) {
        nextJob.status = 'error';
        nextJob.error = err.message;
        // Clean up source on error too
        fs.unlink(nextJob.webpPath, () => {});
      }

      broadcastToSession(nextJob.sessionId, { type: 'jobUpdate', job: sanitizeJob(nextJob) });
    }
  } finally {
    processing = false;
  }
}

// ── WebSocket connection handling ───────────────────────────────────────────

wss.on('connection', (ws) => {
  ws._sessionId = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'register' && data.sessionId) {
        ws._sessionId = data.sessionId;
        // Send current queue state for this session
        const sessionJobs = getSessionJobs(data.sessionId).map(sanitizeJob);
        ws.send(JSON.stringify({ type: 'queueState', jobs: sessionJobs }));
      }
    } catch (_e) {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    // Clean up
  });
});

// ── API Routes ──────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Upload files
app.post('/api/upload', (req, res) => {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
      // Multer error (file too large, wrong type, too many files)
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File troppo grande. Il limite è 50 MB.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? `Troppi file. Il massimo è ${MAX_FILES}.`
          : err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'Campo file inatteso.'
            : err.message;
      return res.status(400).json({ error: message });
    }

    const sessionId = req.body.sessionId;
    if (!sessionId) {
      // Clean up uploaded files
      if (req.files) req.files.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'ID sessione mancante.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nessun file inviato.' });
    }

    const newJobs = [];
    for (const file of req.files) {
      const id = generateId();
      const job = {
        id,
        sessionId,
        originalName: file.originalname,
        status: 'waiting',
        error: null,
        webpPath: file.path,
        pngPath: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        size: file.size
      };
      jobs.set(id, job);
      newJobs.push(sanitizeJob(job));
    }

    // Notify clients
    broadcastToSession(sessionId, { type: 'jobsAdded', jobs: newJobs });

    // Start processing
    processQueue();

    res.json({ added: newJobs.length, jobs: newJobs });
  });
});

// Get queue state for a session
app.get('/api/queue', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'ID sessione mancante.' });
  }
  const sessionJobs = getSessionJobs(sessionId).map(sanitizeJob);
  res.json({ jobs: sessionJobs });
});

// Download single converted PNG
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job non trovato.' });
  }
  if (job.status !== 'completed' || !job.pngPath || !fs.existsSync(job.pngPath)) {
    return res.status(404).json({ error: 'File non disponibile. La conversione potrebbe non essere completata.' });
  }

  const downloadName = job.originalName.replace(/\.webp$/i, '') + '.png';
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  res.sendFile(job.pngPath);
});

// Download all completed PNGs as ZIP
app.get('/api/download-all', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'ID sessione mancante.' });
  }

  const completed = [];
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId && job.status === 'completed' && job.pngPath && fs.existsSync(job.pngPath)) {
      completed.push(job);
    }
  }

  if (completed.length === 0) {
    return res.status(404).json({ error: 'Nessun file PNG disponibile per il download.' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="viraggio-png.zip"');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('Archiver error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Errore nella creazione dell\'archivio ZIP.' });
    }
  });
  archive.pipe(res);

  for (const job of completed) {
    const pngName = job.originalName.replace(/\.webp$/i, '') + '.png';
    archive.file(job.pngPath, { name: pngName });
  }

  archive.finalize();
});

// Clear completed/error jobs for a session
app.delete('/api/queue', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'ID sessione mancante.' });
  }

  let removed = 0;
  for (const [id, job] of jobs) {
    if (job.sessionId === sessionId && (job.status === 'completed' || job.status === 'error')) {
      if (job.pngPath) fs.unlink(job.pngPath, () => {});
      if (job.webpPath) fs.unlink(job.webpPath, () => {});
      jobs.delete(id);
      removed++;
    }
  }

  broadcastToSession(sessionId, { type: 'queueCleared' });
  res.json({ removed });
});

// ── Serve static frontend ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Periodic cleanup ────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'completed' && job.completedAt && (now - job.completedAt > FILE_TTL)) {
      if (job.pngPath) fs.unlink(job.pngPath, () => {});
      jobs.delete(id);
    }
    // Clean up errored jobs after TTL too
    if (job.status === 'error' && job.createdAt && (now - job.createdAt > FILE_TTL)) {
      jobs.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

// ── Start server ────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`✓ Viraggio server attivo su http://${HOST}:${PORT}`);
  console.log(`  Upload:      POST /api/upload`);
  console.log(`  Queue:       GET  /api/queue?sessionId=...`);
  console.log(`  Download:    GET  /api/download/:jobId`);
  console.log(`  DownloadAll: GET  /api/download-all?sessionId=...`);
  console.log(`  WebSocket:   ws://${HOST}:${PORT}`);
});
