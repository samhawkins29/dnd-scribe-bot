#!/usr/bin/env node
/**
 * Tests for transcribe.js
 *
 * Tests the exported functions, utilities, and error handling
 * WITHOUT making real API calls or running real Whisper.
 */

const fs = require('fs');
const path = require('path');
const {
  suite, test, assertEqual, assertTrue, assertFalse,
  assertThrows, assertThrowsAsync, assertIncludes, assertMatch,
  assertType, assertHasProperty,
} = require('./test-runner');

const config = require('../config');

suite('transcribe.js — Module Exports');

const transcribeModule = require('../transcribe');

test('module exports transcribe function', () => {
  assertType(transcribeModule.transcribe, 'function');
});

test('module exports findLatestRecording function', () => {
  assertType(transcribeModule.findLatestRecording, 'function');
});

suite('transcribe.js — formatTime utility');

// We need to access the internal formatTime function.
// Since it's not exported, we'll test it by reading the source and evaluating.
const transcribeSource = fs.readFileSync(path.resolve(__dirname, '../transcribe.js'), 'utf-8');

// Extract and eval the formatTime function
const formatTimeMatch = transcribeSource.match(/function formatTime\(ms\)\s*\{[\s\S]*?^}/m);
let formatTime;
if (formatTimeMatch) {
  eval(`formatTime = ${formatTimeMatch[0]}`);
}

test('formatTime(0) returns 00:00:00', () => {
  if (!formatTime) return assertTrue(false, 'Could not extract formatTime');
  assertEqual(formatTime(0), '00:00:00');
});

test('formatTime(1000) returns 00:00:01', () => {
  if (!formatTime) return assertTrue(false, 'Could not extract formatTime');
  assertEqual(formatTime(1000), '00:00:01');
});

test('formatTime(61000) returns 00:01:01', () => {
  if (!formatTime) return assertTrue(false, 'Could not extract formatTime');
  assertEqual(formatTime(61000), '00:01:01');
});

test('formatTime(3661000) returns 01:01:01', () => {
  if (!formatTime) return assertTrue(false, 'Could not extract formatTime');
  assertEqual(formatTime(3661000), '01:01:01');
});

test('formatTime(7200000) returns 02:00:00', () => {
  if (!formatTime) return assertTrue(false, 'Could not extract formatTime');
  assertEqual(formatTime(7200000), '02:00:00');
});

test('formatTime(500) rounds down partial seconds to 00:00:00', () => {
  if (!formatTime) return assertTrue(false, 'Could not extract formatTime');
  assertEqual(formatTime(500), '00:00:00');
});

suite('transcribe.js — File Validation');

test('transcribe rejects non-existent file', async () => {
  await assertThrowsAsync(
    () => transcribeModule.transcribe('/nonexistent/fake-audio.ogg'),
    'Audio file not found'
  );
});

test('transcribe rejects with clear error message including path', async () => {
  const fakePath = '/tmp/definitely-not-a-file-xyz.ogg';
  try {
    await transcribeModule.transcribe(fakePath);
    assertTrue(false, 'Should have thrown');
  } catch (err) {
    assertIncludes(err.message, 'Audio file not found');
    assertIncludes(err.message, fakePath);
  }
});

suite('transcribe.js — Service Selection');

test('transcribe rejects unknown service', async () => {
  // Create a temporary audio file
  const tmpFile = path.join(config.paths.recordings, '_test_audio.ogg');
  fs.mkdirSync(config.paths.recordings, { recursive: true });
  fs.writeFileSync(tmpFile, 'fake audio data');

  try {
    await assertThrowsAsync(
      () => transcribeModule.transcribe(tmpFile, { service: 'nonexistent-service' }),
      'Unknown transcription service'
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

suite('transcribe.js — findLatestRecording');

test('findLatestRecording throws when recordings dir is empty', () => {
  // Create an empty temp dir
  const tmpDir = path.join(config.paths.recordings, '_test_empty');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Temporarily override config.paths.recordings
  const originalPath = config.paths.recordings;
  config.paths.recordings = tmpDir;

  try {
    assertThrows(
      () => transcribeModule.findLatestRecording(),
      'No recording files found'
    );
  } finally {
    config.paths.recordings = originalPath;
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test('findLatestRecording returns most recent file', () => {
  const tmpDir = path.join(config.paths.recordings, '_test_latest');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Create two fake recording files with different timestamps
  const older = path.join(tmpDir, 'session-2025-01-01.ogg');
  const newer = path.join(tmpDir, 'session-2026-03-15.ogg');
  fs.writeFileSync(older, 'old data');

  // Small delay to ensure different mtime
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
  fs.writeFileSync(newer, 'new data');
  fs.utimesSync(newer, new Date(now), new Date(now));

  const originalPath = config.paths.recordings;
  config.paths.recordings = tmpDir;

  try {
    const result = transcribeModule.findLatestRecording();
    assertIncludes(result, 'session-2026-03-15.ogg');
  } finally {
    config.paths.recordings = originalPath;
    try { fs.unlinkSync(older); } catch {}
    try { fs.unlinkSync(newer); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test('findLatestRecording ignores non-session files', () => {
  const tmpDir = path.join(config.paths.recordings, '_test_filter');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Create a session file and a non-session file
  const session = path.join(tmpDir, 'session-2026-01-01.ogg');
  const nonSession = path.join(tmpDir, 'random-file.txt');
  const tmpPcm = path.join(tmpDir, '_tmp_guild_user_12345.pcm');

  fs.writeFileSync(session, 'audio data');
  fs.writeFileSync(nonSession, 'not audio');
  fs.writeFileSync(tmpPcm, 'temp pcm');

  const originalPath = config.paths.recordings;
  config.paths.recordings = tmpDir;

  try {
    const result = transcribeModule.findLatestRecording();
    assertIncludes(result, 'session-2026-01-01.ogg');
    assertTrue(!result.includes('random-file'));
    assertTrue(!result.includes('_tmp_'));
  } finally {
    config.paths.recordings = originalPath;
    try { fs.unlinkSync(session); } catch {}
    try { fs.unlinkSync(nonSession); } catch {}
    try { fs.unlinkSync(tmpPcm); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test('findLatestRecording supports multiple audio formats', () => {
  const tmpDir = path.join(config.paths.recordings, '_test_formats');
  fs.mkdirSync(tmpDir, { recursive: true });

  const formats = ['ogg', 'pcm', 'wav', 'mp3', 'webm'];
  const files = [];

  for (let i = 0; i < formats.length; i++) {
    const f = path.join(tmpDir, `session-2026-01-0${i + 1}.${formats[i]}`);
    fs.writeFileSync(f, `data ${formats[i]}`);
    const t = Date.now() + (i * 1000);
    fs.utimesSync(f, new Date(t), new Date(t));
    files.push(f);
  }

  const originalPath = config.paths.recordings;
  config.paths.recordings = tmpDir;

  try {
    const result = transcribeModule.findLatestRecording();
    // Should return the most recent one (webm, last in our list)
    assertIncludes(result, '.webm');
  } finally {
    config.paths.recordings = originalPath;
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

suite('transcribe.js — Output Path');

// Test the outputPath function by checking the source
test('output transcript filename follows session-YYYY-MM-DD.txt pattern', () => {
  // We can test this by looking at the source code pattern
  const dateStrMatch = transcribeSource.match(/function dateString\(\)/);
  assertTrue(!!dateStrMatch, 'dateString function should exist');

  const outputPathMatch = transcribeSource.match(/`session-\$\{dateString\(\)\}\.txt`/);
  assertTrue(!!outputPathMatch, 'outputPath should use session-{date}.txt format');
});

suite('transcribe.js — Whisper Command Construction');

test('whisper-local uses correct config values in source', () => {
  // Verify the source references the right config fields
  assertIncludes(transcribeSource, 'config.transcription.whisper');
  assertIncludes(transcribeSource, 'binaryPath');
  assertIncludes(transcribeSource, 'cppModelPath');
});

test('whisper.cpp detection checks file existence', () => {
  assertIncludes(transcribeSource, 'fs.existsSync(cppModelPath)');
});

test('Python whisper uses --output_format json', () => {
  assertIncludes(transcribeSource, '--output_format json');
});

suite('transcribe.js — AssemblyAI Request Formatting');

test('AssemblyAI checks for valid API key', () => {
  assertIncludes(transcribeSource, "apiKey.includes('YOUR_')");
});

test('AssemblyAI uploads audio then creates transcript', () => {
  assertIncludes(transcribeSource, '/upload');
  assertIncludes(transcribeSource, '/transcript');
});

test('AssemblyAI polls for completion', () => {
  assertIncludes(transcribeSource, "result.status === 'completed'");
  assertIncludes(transcribeSource, "result.status === 'error'");
});

test('AssemblyAI formats output with speaker labels', () => {
  assertIncludes(transcribeSource, 'Speaker ${u.speaker}');
});

suite('transcribe.js — Deepgram Request Formatting');

test('Deepgram checks for valid API key', () => {
  assertIncludes(transcribeSource, 'DEEPGRAM_API_KEY');
});

test('Deepgram sends correct URL parameters', () => {
  assertIncludes(transcribeSource, 'URLSearchParams');
  assertIncludes(transcribeSource, "utterances: 'true'");
});

test('Deepgram detects content type from file extension', () => {
  assertIncludes(transcribeSource, "'.ogg': 'audio/ogg'");
  assertIncludes(transcribeSource, "'.wav': 'audio/wav'");
  assertIncludes(transcribeSource, "'.mp3': 'audio/mpeg'");
});

test('Deepgram has fallback for plain transcript', () => {
  assertIncludes(transcribeSource, "'(empty transcript)'");
});

suite('transcribe.js — Speaker Diarization Parsing');

test('AssemblyAI uses utterances for speaker labels', () => {
  assertIncludes(transcribeSource, 'result.utterances');
});

test('Deepgram falls back from utterances to paragraphs', () => {
  assertIncludes(transcribeSource, 'results?.utterances');
  assertIncludes(transcribeSource, 'paragraphs?.paragraphs');
});
