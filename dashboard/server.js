#!/usr/bin/env node
/**
 * D&D Scribe Bot — Dashboard Server
 *
 * Express + Socket.IO server providing a web-based control panel
 * for the entire D&D Scribe system: bot control, recording management,
 * story reading, campaign editing, and settings.
 *
 * Launches at http://localhost:3000
 */

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');
const config = require('../config');
const log = require('../logger');

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

const PORT = process.env.DASHBOARD_PORT || 3000;
// Default to loopback only. The dashboard exposes process-control and
// cost-spending endpoints, so it must not be reachable off-host unless the
// operator opts in by setting DASHBOARD_HOST (and a token, enforced below).
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');

// Shared secret for dashboard auth. If unset, the server stays on loopback and
// logs a loud warning rather than silently exposing an open control panel.
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || process.env.DASHBOARD_PASSWORD || '';

// ─── Auth ────────────────────────────────────────────────────────────

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Require the shared token on every request when DASHBOARD_TOKEN is set.
 * Accepts HTTP Basic auth (password = token), a Bearer token, or ?token=.
 * When no token is configured, requests pass through (loopback-only mode).
 */
function requireAuth(req, res, next) {
  if (!DASHBOARD_TOKEN) return next();

  const header = req.headers.authorization || '';
  let provided = '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    provided = decoded.slice(decoded.indexOf(':') + 1);
  } else if (header.startsWith('Bearer ')) {
    provided = header.slice(7);
  } else if (typeof req.query.token === 'string') {
    provided = req.query.token;
  }

  if (provided && safeEqual(provided, DASHBOARD_TOKEN)) return next();

  res.set('WWW-Authenticate', 'Basic realm="D&D Scribe Dashboard"');
  return res.status(401).json({ error: 'Authentication required.' });
}

// ─── Middleware ──────────────────────────────────────────────────────
app.use(express.json());
app.use(requireAuth); // gate everything (static assets + API) behind the token
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ──────────────────────────────────────────────────────────
let botProcess = null;
let botOnline = false;
let recording = false;
let recordingStart = null;
let connectedChannel = '';
let pipelineRunning = false;
let pipelineStep = '';
let pipelineTarget = '';

function broadcastStatus() {
  io.emit('status', {
    botOnline,
    recording,
    recordingStart: recordingStart ? recordingStart.toISOString() : null,
    connectedChannel,
    pipelineRunning,
    pipelineStep,
    pipelineTarget,
  });
}

// ─── Campaign context validation ─────────────────────────────────────

/**
 * Validate a campaign-context payload before it is written to disk.
 * Enforces the shape the rest of the pipeline relies on: a plain object with
 * string scalar fields and array fields of objects/strings. Unknown extra keys
 * are dropped rather than persisted. Returns { ok, value } or { ok:false, error }.
 */
function validateCampaignContext(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const stringFields = ['campaignName', 'setting', 'dmName', 'currentArc', 'notes'];
  const arrayOfObjectFields = ['playerCharacters', 'recurringNPCs', 'inactiveCharacters'];
  const arrayOfStringFields = ['locationsVisited', 'plotThreads', 'items'];

  const out = {};

  for (const f of stringFields) {
    if (body[f] === undefined) continue;
    if (typeof body[f] !== 'string') return { ok: false, error: `"${f}" must be a string` };
    out[f] = body[f];
  }

  for (const f of arrayOfObjectFields) {
    if (body[f] === undefined) continue;
    if (!Array.isArray(body[f])) return { ok: false, error: `"${f}" must be an array` };
    for (const item of body[f]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, error: `entries of "${f}" must be objects` };
      }
    }
    out[f] = body[f];
  }

  for (const f of arrayOfStringFields) {
    if (body[f] === undefined) continue;
    if (!Array.isArray(body[f]) || body[f].some(s => typeof s !== 'string')) {
      return { ok: false, error: `"${f}" must be an array of strings` };
    }
    out[f] = body[f];
  }

  // Preserve the flavorBank object verbatim if present (it has a known shape
  // managed by the generator) but require it to be a plain object.
  if (body.flavorBank !== undefined) {
    if (!body.flavorBank || typeof body.flavorBank !== 'object' || Array.isArray(body.flavorBank)) {
      return { ok: false, error: '"flavorBank" must be an object' };
    }
    out.flavorBank = body.flavorBank;
  }

  return { ok: true, value: out };
}

// ═══════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Status ────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    botOnline,
    recording,
    recordingStart: recordingStart ? recordingStart.toISOString() : null,
    connectedChannel,
    pipelineRunning,
    pipelineStep,
    pipelineTarget,
  });
});

// ── Bot Control ───────────────────────────────────────────────────
app.post('/api/bot/start', (req, res) => {
  if (botProcess) return res.json({ success: false, message: 'Bot is already running.' });

  botProcess = fork(path.join(ROOT, 'bot.js'), [], {
    cwd: ROOT,
    silent: true,
    env: { ...process.env },
  });

  botProcess.stdout?.on('data', d => {
    const msg = d.toString();
    io.emit('log', msg);
    if (msg.includes('Logged in as')) {
      botOnline = true;
      broadcastStatus();
    }
  });

  botProcess.stderr?.on('data', d => {
    io.emit('log', `[ERR] ${d.toString()}`);
  });

  botProcess.on('exit', (code) => {
    log.info('Bot process exited', { code });
    botProcess = null;
    botOnline = false;
    recording = false;
    recordingStart = null;
    connectedChannel = '';
    broadcastStatus();
  });

  // Give it a moment to start
  setTimeout(() => {
    if (botProcess && !botOnline) {
      botOnline = true; // optimistic — real status comes from stdout
      broadcastStatus();
    }
  }, 3000);

  res.json({ success: true, message: 'Bot starting...' });
});

app.post('/api/bot/stop', (req, res) => {
  if (!botProcess) return res.json({ success: false, message: 'Bot is not running.' });

  botProcess.kill('SIGTERM');
  botProcess = null;
  botOnline = false;
  recording = false;
  recordingStart = null;
  connectedChannel = '';
  broadcastStatus();
  res.json({ success: true, message: 'Bot stopped.' });
});

// ── Recordings ────────────────────────────────────────────────────
app.get('/api/recordings', (req, res) => {
  const dir = config.paths.recordings;
  if (!fs.existsSync(dir)) return res.json([]);

  const files = fs.readdirSync(dir)
    .filter(f => /^session-.*\.(ogg|pcm|wav|mp3|webm)$/.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      const dateMatch = f.match(/session-(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : 'Unknown';

      // Check if transcript and story exist
      const transcriptPath = path.join(config.paths.transcripts, `session-${date}.txt`);
      const hasTranscript = fs.existsSync(transcriptPath);

      const storyFiles = fs.existsSync(config.paths.stories)
        ? fs.readdirSync(config.paths.stories).filter(s => s.includes(date) && s.endsWith('.md') && s.startsWith('chapter'))
        : [];
      const hasStory = storyFiles.length > 0;

      return {
        filename: f,
        date,
        size: (stat.size / 1024 / 1024).toFixed(1) + ' MB',
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        hasTranscript,
        hasStory,
        storyFile: storyFiles[0] || null,
      };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));

  res.json(files);
});

// ── Process a recording (run pipeline) ────────────────────────────
app.post('/api/recordings/process', (req, res) => {
  const { filename, style } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (pipelineRunning) return res.status(409).json({ error: 'Pipeline is already running.' });

  const audioPath = path.join(config.paths.recordings, filename);
  if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'File not found.' });

  pipelineRunning = true;
  pipelineTarget = filename;
  pipelineStep = 'transcribing';
  broadcastStatus();

  const args = [path.join(ROOT, 'run-pipeline.js'), audioPath];
  if (style) args.push('--style', style);

  const proc = spawn('node', args, { cwd: ROOT });

  let output = '';
  proc.stdout.on('data', d => {
    const msg = d.toString();
    output += msg;
    io.emit('pipeline-log', msg);

    if (msg.includes('Step 2')) {
      pipelineStep = 'generating';
      broadcastStatus();
    }
  });

  proc.stderr.on('data', d => {
    io.emit('pipeline-log', `[ERR] ${d.toString()}`);
  });

  proc.on('close', code => {
    pipelineRunning = false;
    pipelineStep = code === 0 ? 'complete' : 'error';
    pipelineTarget = '';
    broadcastStatus();
    io.emit('pipeline-done', { success: code === 0, filename });
  });

  res.json({ success: true, message: 'Pipeline started.' });
});

// ── Stories ───────────────────────────────────────────────────────
app.get('/api/stories', (req, res) => {
  const dir = config.paths.stories;
  if (!fs.existsSync(dir)) return res.json([]);

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('chapter') && f.endsWith('.md'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const title = content.split('\n')[0]?.replace(/^#+\s*/, '') || f;
      const wordCount = content.split(/\s+/).length;
      return {
        filename: f,
        title,
        wordCount,
        size: (stat.size / 1024).toFixed(1) + ' KB',
        modified: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));

  res.json(files);
});

app.get('/api/stories/:filename', (req, res) => {
  // Guard against path traversal: collapse to a bare filename, reject anything
  // that changed (slashes, .. segments) and only allow .md story files.
  const safeName = path.basename(req.params.filename);
  if (safeName !== req.params.filename || !safeName.endsWith('.md')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(config.paths.stories, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.json({ content: fs.readFileSync(filePath, 'utf-8') });
});

app.post('/api/stories/regenerate', (req, res) => {
  const { storyFilename, style } = req.body;
  if (!storyFilename) return res.status(400).json({ error: 'storyFilename required' });
  if (pipelineRunning) return res.status(409).json({ error: 'Pipeline is already running.' });

  // Find the matching transcript
  const dateMatch = storyFilename.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return res.status(400).json({ error: 'Cannot determine date from filename.' });

  const transcriptPath = path.join(config.paths.transcripts, `session-${dateMatch[1]}.txt`);
  if (!fs.existsSync(transcriptPath)) {
    return res.status(404).json({ error: 'Transcript not found for this story.' });
  }

  pipelineRunning = true;
  pipelineStep = 'generating';
  pipelineTarget = storyFilename;
  broadcastStatus();

  const args = [path.join(ROOT, 'generate-story.js'), transcriptPath];
  if (style) args.push('--style', style);

  const proc = spawn('node', args, { cwd: ROOT });

  proc.stdout.on('data', d => io.emit('pipeline-log', d.toString()));
  proc.stderr.on('data', d => io.emit('pipeline-log', `[ERR] ${d.toString()}`));

  proc.on('close', code => {
    pipelineRunning = false;
    pipelineStep = code === 0 ? 'complete' : 'error';
    pipelineTarget = '';
    broadcastStatus();
    io.emit('pipeline-done', { success: code === 0, regenerated: true });
  });

  res.json({ success: true, message: 'Regenerating story...' });
});

// ── Campaign Context ─────────────────────────────────────────────
app.get('/api/campaign', (req, res) => {
  const ctxPath = config.paths.campaignContext;
  if (!fs.existsSync(ctxPath)) {
    return res.json({});
  }
  try {
    res.json(JSON.parse(fs.readFileSync(ctxPath, 'utf-8')));
  } catch {
    res.status(500).json({ error: 'Failed to parse campaign context.' });
  }
});

app.put('/api/campaign', (req, res) => {
  const ctxPath = config.paths.campaignContext;

  // Validate the body instead of writing it verbatim — every downstream pass
  // depends on this file, so a malformed save (wrong type, an array, junk
  // fields) would corrupt the whole pipeline.
  const validation = validateCampaignContext(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: `Invalid campaign context: ${validation.error}` });
  }

  try {
    fs.mkdirSync(path.dirname(ctxPath), { recursive: true });
    fs.writeFileSync(ctxPath, JSON.stringify(validation.value, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Campaign Log ─────────────────────────────────────────────────
app.get('/api/campaign-log', (req, res) => {
  const logPath = config.paths.campaignLog;
  if (!fs.existsSync(logPath)) return res.json({ content: '' });
  res.json({ content: fs.readFileSync(logPath, 'utf-8') });
});

// ── Settings ─────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  // Return current settings (mask sensitive keys)
  const mask = (key) => {
    if (!key || key.includes('YOUR_')) return '';
    if (key.length > 8) return key.slice(0, 4) + '...' + key.slice(-4);
    return '****';
  };

  res.json({
    discordToken: mask(config.discord.token),
    discordClientId: config.discord.clientId,
    anthropicKey: mask(config.anthropic.apiKey),
    anthropicModel: config.anthropic.model,
    transcriptionService: config.transcription.service,
    assemblyaiKey: mask(config.transcription.assemblyai.apiKey),
    deepgramKey: mask(config.transcription.deepgram.apiKey),
    defaultStyle: config.story.defaultStyle,
    audioFormat: config.audio.format,
    whisperModel: config.transcription.whisper.model,
  });
});

app.post('/api/settings/test', async (req, res) => {
  const { service } = req.body;

  if (service === 'discord') {
    const token = config.discord.token;
    if (!token || token.includes('YOUR_')) {
      return res.json({ success: false, message: 'Discord token not configured.' });
    }
    try {
      const r = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      if (r.ok) {
        const data = await r.json();
        return res.json({ success: true, message: `Connected as ${data.username}#${data.discriminator}` });
      }
      return res.json({ success: false, message: `Discord API returned ${r.status}` });
    } catch (err) {
      return res.json({ success: false, message: err.message });
    }
  }

  if (service === 'anthropic') {
    const key = config.anthropic.apiKey;
    if (!key || key.includes('YOUR_')) {
      return res.json({ success: false, message: 'Anthropic key not configured.' });
    }
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.anthropic.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say "ok"' }],
        }),
      });
      if (r.ok) return res.json({ success: true, message: 'Anthropic API connected.' });
      return res.json({ success: false, message: `API returned ${r.status}` });
    } catch (err) {
      return res.json({ success: false, message: err.message });
    }
  }

  res.json({ success: false, message: 'Unknown service.' });
});

// ── Serve index for all non-API routes (SPA) ─────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════════════════════
//  WebSocket
// ═══════════════════════════════════════════════════════════════════

// Authenticate socket connections too — they stream live bot/pipeline logs.
io.use((socket, next) => {
  if (!DASHBOARD_TOKEN) return next();
  const token = socket.handshake.auth?.token
    || socket.handshake.query?.token
    || '';
  if (token && safeEqual(token, DASHBOARD_TOKEN)) return next();
  next(new Error('Authentication required'));
});

io.on('connection', (socket) => {
  log.debug('Dashboard client connected');
  broadcastStatus();

  socket.on('disconnect', () => {
    log.debug('Dashboard client disconnected');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Start Server
// ═══════════════════════════════════════════════════════════════════

if (!DASHBOARD_TOKEN) {
  log.warn(
    'DASHBOARD_TOKEN is not set — the dashboard is UNAUTHENTICATED and will ' +
    `bind to ${HOST} only. Set DASHBOARD_TOKEN (and DASHBOARD_HOST to expose it) ` +
    'before making the control panel reachable off-host.'
  );
}

server.listen(PORT, HOST, () => {
  log.info(`Dashboard running at http://${HOST}:${PORT}`, { authenticated: !!DASHBOARD_TOKEN });
  console.log(`\n  D&D Scribe Bot Dashboard`);
  console.log(`  ────────────────────────`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  Auth: ${DASHBOARD_TOKEN ? 'token required' : 'NONE (set DASHBOARD_TOKEN)'}\n`);
});
