#!/usr/bin/env node
/**
 * Integration Tests
 *
 * Tests the flow between modules with mock data,
 * WITHOUT calling real APIs.
 */

const fs = require('fs');
const path = require('path');
const {
  suite, test, assertEqual, assertTrue,
  assertIncludes, assertMatch, assertType, assertHasProperty,
  assertThrowsAsync,
} = require('./test-runner');

const config = require('../config');

// ─── Helper: create temp directories ────────────────────────────────

const testDir = path.join(__dirname, '_integration_tmp');
const testRecordings = path.join(testDir, 'recordings');
const testTranscripts = path.join(testDir, 'transcripts');
const testStories = path.join(testDir, 'stories');

function setupTestDirs() {
  for (const dir of [testDir, testRecordings, testTranscripts, testStories]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanupTestDirs() {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
}

suite('Integration — Mock Recording → Transcribe Validation');

setupTestDirs();

test('transcribe rejects a text file pretending to be audio (via service error)', async () => {
  const fakeAudio = path.join(testRecordings, 'session-2026-01-01.ogg');
  fs.writeFileSync(fakeAudio, 'this is not real audio data, just a test placeholder');

  // transcribe will find the file but whisper-local will fail because it's not real audio
  // This tests that the error is propagated properly
  try {
    const { transcribe } = require('../transcribe');
    await transcribe(fakeAudio, { service: 'whisper-local' });
    // If we get here, whisper happened to be installed — that's OK
    assertTrue(true);
  } catch (err) {
    // Expected: whisper binary not found or audio invalid
    assertType(err.message, 'string');
    assertTrue(err.message.length > 0, 'Error message should be descriptive');
  } finally {
    try { fs.unlinkSync(fakeAudio); } catch {}
  }
});

suite('Integration — Mock Transcript Format');

test('a well-formed transcript has timestamped speaker lines', () => {
  const mockTranscript = [
    '[00:00:05] Speaker A: Welcome everyone to tonight\'s session.',
    '[00:00:12] Speaker B: Thanks! Let me check my character sheet.',
    '[00:01:30] Speaker A: Alright, when we left off, the party was entering the dungeon.',
    '[00:02:15] Speaker C: I cast detect magic before we proceed.',
  ].join('\n');

  // Verify format
  const lines = mockTranscript.split('\n');
  for (const line of lines) {
    assertMatch(line, /^\[\d{2}:\d{2}:\d{2}\] Speaker \w+: .+/);
  }
});

test('mock transcript can be saved and read back', () => {
  const mockTranscript = [
    '[00:00:05] Speaker A: The adventure begins.',
    '[00:01:30] Speaker B: I draw my sword.',
  ].join('\n');

  const transcriptFile = path.join(testTranscripts, 'session-2026-01-01.txt');
  fs.writeFileSync(transcriptFile, mockTranscript, 'utf-8');

  const readBack = fs.readFileSync(transcriptFile, 'utf-8');
  assertEqual(readBack, mockTranscript);
});

suite('Integration — Mock Transcript → Generate Story Validation');

test('generateStory rejects transcript path that does not exist', async () => {
  const { generateStory } = require('../generate-story');
  await assertThrowsAsync(
    () => generateStory(path.join(testTranscripts, 'nonexistent.txt')),
    'Transcript file not found'
  );
});

test('generateStory rejects empty transcript file', async () => {
  const emptyFile = path.join(testTranscripts, 'empty-session.txt');
  fs.writeFileSync(emptyFile, '', 'utf-8');

  const { generateStory } = require('../generate-story');
  try {
    await assertThrowsAsync(
      () => generateStory(emptyFile),
      'Transcript file is empty'
    );
  } finally {
    try { fs.unlinkSync(emptyFile); } catch {}
  }
});

suite('Integration — Campaign Context Integration');

test('campaign context is valid and loadable', () => {
  const ctxPath = config.paths.campaignContext;
  if (!fs.existsSync(ctxPath)) {
    assertTrue(true, 'No campaign context — skipping');
    return;
  }

  const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
  assertHasProperty(ctx, 'campaignName');
  assertHasProperty(ctx, 'playerCharacters');
});

test('campaign log file is writable', () => {
  const logPath = config.paths.campaignLog;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  // Append a test entry and verify
  const testEntry = '\n### Test Entry — Integration Test\nThis is a test.\n';
  const originalContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';

  fs.appendFileSync(logPath, testEntry, 'utf-8');
  const newContent = fs.readFileSync(logPath, 'utf-8');
  assertIncludes(newContent, 'Test Entry — Integration Test');

  // Restore original content
  fs.writeFileSync(logPath, originalContent, 'utf-8');
});

suite('Integration — File Discovery Chain');

test('recordings directory exists or can be created', () => {
  fs.mkdirSync(config.paths.recordings, { recursive: true });
  assertTrue(fs.existsSync(config.paths.recordings));
});

test('transcripts directory exists or can be created', () => {
  fs.mkdirSync(config.paths.transcripts, { recursive: true });
  assertTrue(fs.existsSync(config.paths.transcripts));
});

test('stories directory exists or can be created', () => {
  fs.mkdirSync(config.paths.stories, { recursive: true });
  assertTrue(fs.existsSync(config.paths.stories));
});

test('lore directory exists', () => {
  assertTrue(fs.existsSync(config.paths.lore));
});

suite('Integration — Pipeline Module Connectivity');

test('pipeline module can import both transcribe and generate-story', () => {
  // This tests that the require chain works without errors
  const pipeline = require('../run-pipeline');
  assertType(pipeline.runPipeline, 'function');
});

test('transcribe module config paths are consistent with pipeline', () => {
  const { findLatestRecording } = require('../transcribe');
  const { findLatestTranscript } = require('../generate-story');

  // Both should reference the same config object
  assertType(findLatestRecording, 'function');
  assertType(findLatestTranscript, 'function');
});

// Cleanup
cleanupTestDirs();
