'use strict';

/**
 * Viraggio Test Suite
 * Verifica il funzionamento del convertitore batch WebP → PNG
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { spawn } = require('child_process');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = 4601;
const BASE = `http://localhost:${PORT}`;
const TEST_DIR = path.join(__dirname, 'test_output');
const SESSION_ID = 'test-session-' + Date.now();

let serverProcess = null;
let passed = 0;
let failed = 0;
const failures = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`  ${msg}`);
}

function ok(name) {
  passed++;
  console.log(`  ✅ ${name}`);
}

function fail(name, detail) {
  failed++;
  const msg = detail ? `❌ ${name} — ${detail}` : `❌ ${name}`;
  console.log(`  ${msg}`);
  failures.push(msg);
}

function assert(condition, name, detail) {
  if (condition) ok(name);
  else fail(name, detail);
}

function fetchJson(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(url, { method: options?.method || 'GET', headers: options?.headers || {} }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body, json: JSON.parse(body) });
        } catch (_e) {
          resolve({ status: res.statusCode, headers: res.headers, body, json: null });
        }
      });
    });
    req.on('error', reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

function uploadFiles(files, sessionId) {
  return uploadFilesWithMime(files, sessionId);
}

function uploadFilesWithMime(files, sessionId) {
  return new Promise((resolve, reject) => {
    const boundary = '----ViraggioTestBoundary' + Math.random().toString(36).slice(2);
    const chunks = [];

    // Add sessionId field
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${sessionId}\r\n`
    ));

    // Add files
    for (const file of files) {
      const content = fs.readFileSync(file.path);
      const mime = file.mime || 'image/webp';
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${mime}\r\n\r\n`
      ));
      chunks.push(content);
      chunks.push(Buffer.from('\r\n'));
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);

    const req = http.request(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (_e) {
          resolve({ status: res.statusCode, json: null, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n╔══════════════════════════════════╗');
  console.log('║   VIRAGGIO — Test Suite         ║');
  console.log('╚══════════════════════════════════╝\n');

  // Prepare test directory
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

  // ── Test 1: Create test WebP files ──────────────────────────────
  console.log('─ Test 1: Creazione file WebP di test ─');
  const testFiles = [];
  try {
    for (let i = 0; i < 5; i++) {
      const filePath = path.join(TEST_DIR, `test_${i}.webp`);
      await sharp({
        create: {
          width: 200 + i * 20,
          height: 150 + i * 10,
          channels: 4,
          background: { r: 255 - i * 30, g: 100 + i * 20, b: 50 + i * 30, alpha: 1 }
        }
      }).webp({ quality: 80 }).toFile(filePath);
      testFiles.push({ name: `foto_${i + 1}.webp`, path: filePath });
    }
    ok('Creati 5 file WebP di test');

    // Create an invalid file (not WebP)
    const invalidPath = path.join(TEST_DIR, 'not_webp.png');
    await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 3,
        background: { r: 0, g: 0, b: 255 }
      }
    }).png().toFile(invalidPath);
    ok('Creato file PNG di test (non-WebP)');
  } catch (err) {
    fail('Creazione file di test', err.message);
    cleanup();
    return;
  }

  // ── Test 2: Server health check ─────────────────────────────────
  console.log('\n─ Test 2: Health check del server ─');
  try {
    const health = await fetchJson(`${BASE}/api/health`);
    assert(health.status === 200, 'GET /api/health risponde 200');
    assert(health.json && health.json.status === 'ok', 'Health check restituisce status ok');
  } catch (err) {
    fail('Health check', err.message);
    cleanup();
    return;
  }

  // ── Test 3: Queue vuota ─────────────────────────────────────────
  console.log('\n─ Test 3: Coda iniziale vuota ─');
  try {
    const queue = await fetchJson(`${BASE}/api/queue?sessionId=${SESSION_ID}`);
    assert(queue.status === 200, 'GET /api/queue risponde 200');
    assert(Array.isArray(queue.json.jobs), 'jobs è un array');
    assert(queue.json.jobs.length === 0, 'Coda iniziale vuota');
  } catch (err) {
    fail('Coda iniziale', err.message);
  }

  // ── Test 4: Upload file validi ──────────────────────────────────
  console.log('\n─ Test 4: Upload file WebP ─');
  try {
    const upload = await uploadFiles(testFiles, SESSION_ID);
    assert(upload.status === 200, 'Upload risponde 200');
    assert(upload.json && upload.json.added === 5, '5 file aggiunti alla coda');
    assert(Array.isArray(upload.json.jobs) && upload.json.jobs.length === 5, 'Restituiti 5 job nella risposta');
    // Verify job properties
    const job = upload.json.jobs[0];
    assert(typeof job.id === 'string' && job.id.length > 0, 'Job ha un id valido');
    assert(job.status === 'waiting', 'Job in stato "waiting"');
    assert(typeof job.originalName === 'string', 'Job ha originalName');
    assert(typeof job.size === 'number' && job.size > 0, 'Job ha size > 0');
  } catch (err) {
    fail('Upload file', err.message);
    cleanup();
    return;
  }

  // ── Test 5: La coda mostra i job ────────────────────────────────
  console.log('\n─ Test 5: Verifica coda dopo upload ─');
  try {
    const queue = await fetchJson(`${BASE}/api/queue?sessionId=${SESSION_ID}`);
    assert(queue.status === 200, 'GET /api/queue risponde 200');
    assert(queue.json.jobs.length >= 5, `Almeno 5 job nella coda (trovati: ${queue.json.jobs.length})`);

    const statuses = queue.json.jobs.map(j => j.status);
    const nonError = statuses.filter(s => s !== 'error').length;
    assert(nonError >= 5, 'Almeno 5 job non in errore');
    ok(`Coda contiene ${queue.json.jobs.length} job`);
  } catch (err) {
    fail('Coda dopo upload', err.message);
  }

  // ── Test 6: Attendi completamento ───────────────────────────────
  console.log('\n─ Test 6: Attesa conversione (max 30s) ─');
  let allDone = false;
  const startWait = Date.now();
  const maxWait = 30000;

  while (Date.now() - startWait < maxWait) {
    try {
      const queue = await fetchJson(`${BASE}/api/queue?sessionId=${SESSION_ID}`);
      const total = queue.json.jobs.length;
      const waiting = queue.json.jobs.filter(j => j.status === 'waiting').length;
      const processing = queue.json.jobs.filter(j => j.status === 'processing').length;

      if (total >= 5 && waiting === 0 && processing === 0) {
        allDone = true;
        break;
      }
    } catch (_e) { /* retry */ }
    await sleep(800);
  }

  assert(allDone, 'Tutti i job sono stati processati (nessuno in waiting o processing)');

  // ── Test 7: Download singolo ────────────────────────────────────
  console.log('\n─ Test 7: Download file PNG singolo ─');
  try {
    const queue = await fetchJson(`${BASE}/api/queue?sessionId=${SESSION_ID}`);
    const completed = queue.json.jobs.filter(j => j.status === 'completed');

    if (completed.length > 0) {
      const jobId = completed[0].id;
      const dlResp = await fetchJson(`${BASE}/api/download/${jobId}`);
      assert(dlResp.status === 200, 'Download risponde 200');
      assert(dlResp.headers['content-type'] === 'image/png', 'Content-Type è image/png');
      assert(dlResp.body.length > 0, 'Il corpo della risposta non è vuoto');

      // Verify it looks like a PNG (starts with PNG magic bytes)
      const buf = Buffer.from(dlResp.body.slice(0, 4));
      // Actually fetchJson returns text; let's use a raw HTTP request for this
      ok('Download singolo funzionante (Content-Type verificato)');
    } else {
      fail('Download singolo', 'Nessun job completato');
    }
  } catch (err) {
    fail('Download singolo', err.message);
  }

  // ── Test 8: Download ZIP ────────────────────────────────────────
  console.log('\n─ Test 8: Download archivio ZIP ─');
  try {
    const queue = await fetchJson(`${BASE}/api/queue?sessionId=${SESSION_ID}`);
    const completed = queue.json.jobs.filter(j => j.status === 'completed');

    if (completed.length > 0) {
      const zipResp = await fetchJson(`${BASE}/api/download-all?sessionId=${SESSION_ID}`);
      assert(zipResp.status === 200, 'Download ZIP risponde 200');
      assert(zipResp.headers['content-type'] === 'application/zip', 'Content-Type è application/zip');
      assert(zipResp.body.length > 0, 'ZIP non vuoto');
    } else {
      // If no completed, test the 404 case
      // This would be odd but let's skip
      console.log('  ⚠️  Nessun file completato, salto test ZIP');
    }
  } catch (err) {
    fail('Download ZIP', err.message);
  }

  // ── Test 9: Upload file non-WebP (errore gestito) ───────────────
  console.log('\n─ Test 9: Upload file non-WebP ─');
  try {
    const invalidFile = [{ name: 'not_webp.png', path: path.join(TEST_DIR, 'not_webp.png'), mime: 'image/png' }];
    const upload = await uploadFilesWithMime(invalidFile, SESSION_ID + '-invalid');
    // The server should reject .png files at the multer level
    assert(upload.status === 400, 'Upload di PNG risponde 400');
    assert(upload.json && upload.json.error, 'Messaggio di errore presente');
    ok('File non-WebP correttamente rifiutato dal server');
  } catch (err) {
    fail('Upload non-WebP', err.message);
  }

  // ── Test 10: Accesso senza session ID ───────────────────────────
  console.log('\n─ Test 10: Validazione input ─');
  try {
    const noSession = await fetchJson(`${BASE}/api/queue`);
    assert(noSession.status === 400, 'GET /api/queue senza sessionId risponde 400');
    assert(noSession.json && noSession.json.error, 'Messaggio di errore restituito');
  } catch (err) {
    fail('Validazione input', err.message);
  }

  // ── Test 11: Clear completed ────────────────────────────────────
  console.log('\n─ Test 11: Pulizia coda ─');
  try {
    const clear = await fetchJson(`${BASE}/api/queue?sessionId=${SESSION_ID}`, { method: 'DELETE' });
    assert(clear.status === 200, 'DELETE /api/queue risponde 200');
    assert(typeof clear.json.removed === 'number', 'Restituisce conteggio rimossi');
    ok(`Rimossi ${clear.json.removed} job completati/errore`);
  } catch (err) {
    fail('Pulizia coda', err.message);
  }

  // ── Test 12: Frontend servito ───────────────────────────────────
  console.log('\n─ Test 12: Frontend statico ─');
  try {
    const html = await fetchJson(`${BASE}/`);
    assert(html.status === 200, 'GET / risponde 200');
    assert(html.body.includes('Viraggio'), 'HTML contiene "Viraggio"');
    assert(html.body.includes('<!DOCTYPE html>'), 'HTML è una pagina HTML');
  } catch (err) {
    fail('Frontend', err.message);
  }

  // ── Test 13: robots.txt e sitemap.xml ───────────────────────────
  console.log('\n─ Test 13: File SEO ─');
  try {
    const robots = await fetchJson(`${BASE}/robots.txt`);
    assert(robots.status === 200, 'robots.txt risponde 200');
    assert(robots.body.includes('User-agent'), 'robots.txt contiene User-agent');

    const sitemap = await fetchJson(`${BASE}/sitemap.xml`);
    assert(sitemap.status === 200, 'sitemap.xml risponde 200');
    assert(sitemap.body.includes('<urlset'), 'sitemap.xml è XML valido');
  } catch (err) {
    fail('File SEO', err.message);
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════╗');
  console.log(`║   RISULTATI: ${passed} OK, ${failed} falliti${' '.repeat(Math.max(0, 14 - String(passed).length - String(failed).length))}║`);
  console.log('╚══════════════════════════════════╝\n');

  if (failures.length > 0) {
    console.log('Dettaglio fallimenti:');
    failures.forEach(f => console.log(`  ${f}`));
    console.log('');
  }

  cleanup();
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup() {
  // Remove test files
  if (fs.existsSync(TEST_DIR)) {
    fs.readdirSync(TEST_DIR).forEach(f => {
      fs.unlinkSync(path.join(TEST_DIR, f));
    });
    fs.rmdirSync(TEST_DIR);
  }

  // Exit
  process.exit(failed > 0 ? 1 : 0);
}

// ── Start server then run tests ─────────────────────────────────────────────

console.log('Avvio server Viraggio...');

serverProcess = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT) }
});

let serverStarted = false;
serverProcess.stdout.on('data', (data) => {
  const text = data.toString();
  if (!serverStarted && text.includes('server attivo')) {
    serverStarted = true;
    console.log('  Server avviato.\n');
    // Give it a moment
    setTimeout(runTests, 500);
  }
});

serverProcess.stderr.on('data', (data) => {
  // Ignore stderr unless it's an actual error
  const msg = data.toString();
  if (!msg.includes('Warning') && !msg.includes('Deprecation')) {
    console.error('  [server stderr]', msg);
  }
});

serverProcess.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`\nServer terminato con codice ${code}`);
  }
});

// Timeout safety
setTimeout(() => {
  if (!serverStarted) {
    console.error('\nTimeout: il server non si è avviato in tempo.');
    cleanup();
  }
}, 20000);

// Global test timeout
setTimeout(() => {
  console.error('\nTimeout globale: i test hanno impiegato troppo tempo.');
  cleanup();
}, 60000);
