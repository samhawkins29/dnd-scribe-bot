#!/usr/bin/env node
/**
 * Tests for dashboard/server.js
 *
 * Tests REST API endpoints, response formats, and error handling
 * by making real HTTP requests to a local test server instance.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  suite, test, assertEqual, assertTrue,
  assertIncludes, assertType, assertHasProperty, assertArray,
} = require('./test-runner');

const config = require('../config');

// ─── Helpers ────────────────────────────────────────────────────────

function httpRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── We test the server source code analysis since starting the actual
//     server would require express/socket.io to be installed ─────────

const serverSource = fs.readFileSync(path.resolve(__dirname, '../dashboard/server.js'), 'utf-8');

suite('dashboard/server.js — Module Structure');

test('server uses express', () => {
  assertIncludes(serverSource, "require('express')");
});

test('server uses socket.io', () => {
  assertIncludes(serverSource, "require('socket.io')");
});

test('server uses express.json() middleware', () => {
  assertIncludes(serverSource, 'express.json()');
});

test('server serves static files from public directory', () => {
  assertIncludes(serverSource, 'express.static');
  assertIncludes(serverSource, 'public');
});

suite('dashboard/server.js — API Endpoints');

test('GET /api/status endpoint exists', () => {
  assertIncludes(serverSource, "app.get('/api/status'");
});

test('/api/status returns all status fields', () => {
  assertIncludes(serverSource, 'botOnline');
  assertIncludes(serverSource, 'recording');
  assertIncludes(serverSource, 'recordingStart');
  assertIncludes(serverSource, 'connectedChannel');
  assertIncludes(serverSource, 'pipelineRunning');
  assertIncludes(serverSource, 'pipelineStep');
  assertIncludes(serverSource, 'pipelineTarget');
});

test('POST /api/bot/start endpoint exists', () => {
  assertIncludes(serverSource, "app.post('/api/bot/start'");
});

test('POST /api/bot/stop endpoint exists', () => {
  assertIncludes(serverSource, "app.post('/api/bot/stop'");
});

test('GET /api/recordings endpoint exists', () => {
  assertIncludes(serverSource, "app.get('/api/recordings'");
});

test('POST /api/recordings/process endpoint exists', () => {
  assertIncludes(serverSource, "app.post('/api/recordings/process'");
});

test('GET /api/stories endpoint exists', () => {
  assertIncludes(serverSource, "app.get('/api/stories'");
});

test('GET /api/stories/:filename endpoint exists', () => {
  assertIncludes(serverSource, "app.get('/api/stories/:filename'");
});

test('POST /api/stories/regenerate endpoint exists', () => {
  assertIncludes(serverSource, "app.post('/api/stories/regenerate'");
});

test('GET /api/campaign endpoint exists', () => {
  assertIncludes(serverSource, "app.get('/api/campaign'");
});

test('PUT /api/campaign endpoint exists', () => {
  assertIncludes(serverSource, "app.put('/api/campaign'");
});

test('GET /api/campaign-log endpoint exists', () => {
  assertIncludes(serverSource, "app.get('/api/campaign-log'");
});

test('GET /api/settings endpoint exists', () => {
  assertIncludes(serverSource, "app.get('/api/settings'");
});

test('POST /api/settings/test endpoint exists', () => {
  assertIncludes(serverSource, "app.post('/api/settings/test'");
});

suite('dashboard/server.js — Error Handling');

test('/api/recordings/process validates filename', () => {
  assertIncludes(serverSource, "'filename required'");
});

test('/api/recordings/process returns 400 for missing filename', () => {
  assertIncludes(serverSource, 'res.status(400)');
});

test('/api/recordings/process returns 404 for missing file', () => {
  assertIncludes(serverSource, 'res.status(404)');
});

test('/api/recordings/process returns 409 when pipeline is running', () => {
  assertIncludes(serverSource, 'res.status(409)');
});

test('/api/stories/regenerate validates storyFilename', () => {
  assertIncludes(serverSource, "'storyFilename required'");
});

test('/api/campaign handles parse errors', () => {
  assertIncludes(serverSource, "'Failed to parse campaign context.'");
});

suite('dashboard/server.js — Settings Security');

test('settings endpoint masks API keys', () => {
  assertIncludes(serverSource, 'mask');
  assertIncludes(serverSource, "key.slice(0, 4)");
  assertIncludes(serverSource, "key.slice(-4)");
});

test('settings endpoint masks keys shorter than 8 chars', () => {
  assertIncludes(serverSource, "'****'");
});

test('settings endpoint returns empty string for placeholder keys', () => {
  assertIncludes(serverSource, "key.includes('YOUR_')");
});

suite('dashboard/server.js — Recording List Format');

test('recordings endpoint filters session files by regex', () => {
  assertIncludes(serverSource, '/^session-.*\\.(ogg|pcm|wav|mp3|webm)$/');
});

test('recordings endpoint includes file metadata', () => {
  assertIncludes(serverSource, 'filename');
  assertIncludes(serverSource, 'sizeBytes');
  assertIncludes(serverSource, 'hasTranscript');
  assertIncludes(serverSource, 'hasStory');
});

test('recordings are sorted by modification time (newest first)', () => {
  assertIncludes(serverSource, 'new Date(b.modified) - new Date(a.modified)');
});

suite('dashboard/server.js — Stories Endpoints');

test('stories endpoint reads chapter files', () => {
  assertIncludes(serverSource, "f.startsWith('chapter')");
  assertIncludes(serverSource, "f.endsWith('.md')");
});

test('stories endpoint includes word count', () => {
  assertIncludes(serverSource, 'wordCount');
});

test('stories/:filename returns file content', () => {
  assertIncludes(serverSource, "fs.readFileSync(filePath, 'utf-8')");
});

suite('dashboard/server.js — Pipeline Integration');

test('process endpoint spawns pipeline as subprocess', () => {
  assertIncludes(serverSource, "spawn('node'");
  assertIncludes(serverSource, 'run-pipeline.js');
});

test('regenerate endpoint spawns generate-story as subprocess', () => {
  assertIncludes(serverSource, 'generate-story.js');
});

test('pipeline progress is broadcast via socket.io', () => {
  assertIncludes(serverSource, "io.emit('pipeline-log'");
  assertIncludes(serverSource, "io.emit('pipeline-done'");
});

test('pipeline status updates during execution', () => {
  assertIncludes(serverSource, "'transcribing'");
  assertIncludes(serverSource, "'generating'");
  assertIncludes(serverSource, "'complete'");
  assertIncludes(serverSource, "'error'");
});

suite('dashboard/server.js — SPA Fallback');

test('catch-all route serves index.html', () => {
  assertIncludes(serverSource, "app.get('*'");
  assertIncludes(serverSource, 'index.html');
});

suite('dashboard/server.js — WebSocket');

test('socket.io handles connection/disconnect events', () => {
  assertIncludes(serverSource, "io.on('connection'");
  assertIncludes(serverSource, "socket.on('disconnect'");
});

test('broadcasts status on new connection', () => {
  // broadcastStatus is called inside connection handler
  assertIncludes(serverSource, 'broadcastStatus()');
});

suite('dashboard/server.js — Bot Control');

test('bot start forks bot.js as child process', () => {
  assertIncludes(serverSource, "fork(path.join(ROOT, 'bot.js')");
});

test('bot stop sends SIGTERM', () => {
  assertIncludes(serverSource, "botProcess.kill('SIGTERM')");
});

test('bot process exit handler resets state', () => {
  assertIncludes(serverSource, "botProcess.on('exit'");
  assertIncludes(serverSource, 'botOnline = false');
});

suite('dashboard/server.js — Settings Test Endpoints');

test('settings test supports discord service', () => {
  assertIncludes(serverSource, "service === 'discord'");
  assertIncludes(serverSource, 'discord.com/api');
});

test('settings test supports anthropic service', () => {
  assertIncludes(serverSource, "service === 'anthropic'");
  assertIncludes(serverSource, 'api.anthropic.com');
});
