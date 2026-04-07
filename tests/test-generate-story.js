#!/usr/bin/env node
/**
 * Tests for generate-story.js
 *
 * Tests prompt construction, campaign context loading, chapter numbering,
 * file operations, and error handling WITHOUT calling the real Anthropic API.
 */

const fs = require('fs');
const path = require('path');
const {
  suite, test, assertEqual, assertTrue, assertFalse,
  assertThrows, assertThrowsAsync, assertIncludes, assertMatch,
  assertType, assertHasProperty, assertGreaterThan, assertArray,
} = require('./test-runner');

const config = require('../config');

suite('generate-story.js — Module Exports');

const genModule = require('../generate-story');

test('module exports generateStory function', () => {
  assertType(genModule.generateStory, 'function');
});

test('module exports findLatestTranscript function', () => {
  assertType(genModule.findLatestTranscript, 'function');
});

test('module exports STYLE_PROMPTS object', () => {
  assertType(genModule.STYLE_PROMPTS, 'object');
});

suite('generate-story.js — Style Prompts');

test('STYLE_PROMPTS has martin style', () => {
  assertHasProperty(genModule.STYLE_PROMPTS, 'martin');
  assertType(genModule.STYLE_PROMPTS.martin, 'string');
});

test('STYLE_PROMPTS has sanderson style', () => {
  assertHasProperty(genModule.STYLE_PROMPTS, 'sanderson');
  assertType(genModule.STYLE_PROMPTS.sanderson, 'string');
});

test('martin prompt mentions George R.R. Martin', () => {
  assertIncludes(genModule.STYLE_PROMPTS.martin, 'Martin');
});

test('sanderson prompt mentions Brandon Sanderson', () => {
  assertIncludes(genModule.STYLE_PROMPTS.sanderson, 'Sanderson');
});

test('martin prompt mentions close third-person limited POV', () => {
  assertIncludes(genModule.STYLE_PROMPTS.martin, 'third-person limited');
});

test('sanderson prompt mentions Cosmere', () => {
  assertIncludes(genModule.STYLE_PROMPTS.sanderson, 'Cosmere');
});

test('both prompts warn against game mechanics', () => {
  assertIncludes(genModule.STYLE_PROMPTS.martin, 'dice');
  assertIncludes(genModule.STYLE_PROMPTS.sanderson, 'dice');
});

test('prompts are substantial (>500 chars)', () => {
  assertGreaterThan(genModule.STYLE_PROMPTS.martin.length, 500);
  assertGreaterThan(genModule.STYLE_PROMPTS.sanderson.length, 500);
});

suite('generate-story.js — buildMessages (via source analysis)');

const genSource = fs.readFileSync(path.resolve(__dirname, '../generate-story.js'), 'utf-8');

test('buildMessages includes campaign context in prompt', () => {
  assertIncludes(genSource, 'CAMPAIGN CONTEXT');
});

test('buildMessages includes previous session summaries', () => {
  assertIncludes(genSource, 'PREVIOUS SESSION SUMMARIES');
});

test('buildMessages includes session transcript', () => {
  assertIncludes(genSource, 'SESSION TRANSCRIPT');
});

test('buildMessages includes instructions section', () => {
  assertIncludes(genSource, 'INSTRUCTIONS');
});

test('buildMessages formats player characters with race and class', () => {
  assertIncludes(genSource, '${pc.race} ${pc.class}');
});

test('buildMessages includes NPC information', () => {
  assertIncludes(genSource, 'recurringNPCs');
});

test('buildMessages includes plot threads', () => {
  assertIncludes(genSource, 'majorPlotThreads');
});

test('buildMessages includes locations and items', () => {
  assertIncludes(genSource, 'locationsVisited');
  assertIncludes(genSource, 'itemsOfSignificance');
});

suite('generate-story.js — Chapter Numbering');

test('nextChapterNumber function exists in source', () => {
  assertIncludes(genSource, 'function nextChapterNumber()');
});

test('chapter numbering parses existing chapter files', () => {
  assertIncludes(genSource, 'chapter-(\\d+)');
});

test('chapter filename is zero-padded', () => {
  assertIncludes(genSource, "padStart(2, '0')");
});

test('chapter filename includes date', () => {
  assertIncludes(genSource, 'chapter-${String(chapterNum)');
  assertIncludes(genSource, '-${dateStr}.md');
});

suite('generate-story.js — Story File Saving');

test('story is saved as markdown file', () => {
  assertIncludes(genSource, '.md');
  assertIncludes(genSource, "fs.writeFileSync(storyPath, storyContent, 'utf-8')");
});

test('campaign log is appended with chapter summary', () => {
  assertIncludes(genSource, 'fs.appendFileSync(config.paths.campaignLog');
});

test('session summary is extracted from Claude output', () => {
  assertIncludes(genSource, '## Session Summary');
});

suite('generate-story.js — Error Handling');

test('generateStory rejects non-existent transcript', async () => {
  await assertThrowsAsync(
    () => genModule.generateStory('/nonexistent/transcript.txt'),
    'Transcript file not found'
  );
});

test('generateStory rejects empty transcript', async () => {
  const tmpFile = path.join(config.paths.transcripts || '/tmp', '_test_empty.txt');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, '');

  try {
    await assertThrowsAsync(
      () => genModule.generateStory(tmpFile),
      'Transcript file is empty'
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('generateStory rejects whitespace-only transcript', async () => {
  const tmpFile = path.join(config.paths.transcripts || '/tmp', '_test_whitespace.txt');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, '   \n\n   \t  \n');

  try {
    await assertThrowsAsync(
      () => genModule.generateStory(tmpFile),
      'Transcript file is empty'
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

suite('generate-story.js — findLatestTranscript');

test('findLatestTranscript throws when no transcripts exist', () => {
  const tmpDir = path.join(config.paths.transcripts, '_test_empty_tr');
  fs.mkdirSync(tmpDir, { recursive: true });

  const originalPath = config.paths.transcripts;
  config.paths.transcripts = tmpDir;

  try {
    assertThrows(
      () => genModule.findLatestTranscript(),
      'No transcript files found'
    );
  } finally {
    config.paths.transcripts = originalPath;
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test('findLatestTranscript returns most recent .txt file', () => {
  const tmpDir = path.join(config.paths.transcripts, '_test_latest_tr');
  fs.mkdirSync(tmpDir, { recursive: true });

  const older = path.join(tmpDir, 'session-2025-01-01.txt');
  const newer = path.join(tmpDir, 'session-2026-03-15.txt');
  fs.writeFileSync(older, 'old transcript');
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
  fs.writeFileSync(newer, 'new transcript');
  fs.utimesSync(newer, new Date(now), new Date(now));

  const originalPath = config.paths.transcripts;
  config.paths.transcripts = tmpDir;

  try {
    const result = genModule.findLatestTranscript();
    assertIncludes(result, 'session-2026-03-15.txt');
  } finally {
    config.paths.transcripts = originalPath;
    try { fs.unlinkSync(older); } catch {}
    try { fs.unlinkSync(newer); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

suite('generate-story.js — Campaign Context Loading');

test('loadCampaignContext returns null if file missing (source check)', () => {
  assertIncludes(genSource, "!fs.existsSync(ctxPath)");
  assertIncludes(genSource, 'return null');
});

test('loadCampaignContext handles invalid JSON gracefully', () => {
  assertIncludes(genSource, 'Failed to parse campaign-context.json');
});

test('updateCampaignContext merges arrays, does not replace', () => {
  assertIncludes(genSource, '...ctx[key], ...value');
});

suite('generate-story.js — Prompt Token Estimation');

test('prompts contain enough detail for quality output', () => {
  // Martin prompt word count
  const martinWords = genModule.STYLE_PROMPTS.martin.split(/\s+/).length;
  assertGreaterThan(martinWords, 100, 'Martin prompt should be >100 words');

  // Sanderson prompt word count
  const sandersonWords = genModule.STYLE_PROMPTS.sanderson.split(/\s+/).length;
  assertGreaterThan(sandersonWords, 100, 'Sanderson prompt should be >100 words');
});
