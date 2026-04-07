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
const ROOT = path.resolve(__dirname, '..');

// ─── Middleware ──────────────────────────────────────────────────────
app.use(express.json());
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
  const filePath = path.join(config.paths.stories, req.params.filename);
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
  try {
    fs.mkdirSync(path.dirname(ctxPath), { recursive: true });
    fs.writeFileSync(ctxPath, JSON.stringify(req.body, null, 2), 'utf-8');
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

server.listen(PORT, () => {
  log.info(`Dashboard running at http://localhost:${PORT}`);
  console.log(`\n  D&D Scribe Bot Dashboard`);
  console.log(`  ────────────────────────`);
  console.log(`  http://localhost:${PORT}\n`);
});
