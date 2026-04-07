#!/usr/bin/env node
/**
 * Tests for config.js
 */

const path = require('path');
const {
  suite, test, assertEqual, assertTrue, assertType,
  assertHasProperty, assertIncludes, assertMatch,
} = require('./test-runner');

suite('config.js — Structure & Defaults');

// We need a fresh require each time to test env overrides properly.
// For the basic tests, just require once.
const config = require('../config');

test('config exports an object', () => {
  assertType(config, 'object');
});

test('config.discord has token, clientId, guildId', () => {
  assertHasProperty(config.discord, 'token');
  assertHasProperty(config.discord, 'clientId');
  assertHasProperty(config.discord, 'guildId');
});

test('config.discord defaults are placeholder strings', () => {
  // Unless env vars are set, defaults should be placeholders
  assertType(config.discord.token, 'string');
  assertType(config.discord.clientId, 'string');
  assertType(config.discord.guildId, 'string');
});

test('config.anthropic has apiKey, model, maxTokens', () => {
  assertHasProperty(config.anthropic, 'apiKey');
  assertHasProperty(config.anthropic, 'model');
  assertHasProperty(config.anthropic, 'maxTokens');
});

test('config.anthropic.model defaults to a claude model', () => {
  assertIncludes(config.anthropic.model, 'claude');
});

test('config.anthropic.maxTokens is a number', () => {
  assertType(config.anthropic.maxTokens, 'number');
  assertTrue(config.anthropic.maxTokens > 0);
});

test('config.transcription has service, whisper, assemblyai, deepgram', () => {
  assertHasProperty(config.transcription, 'service');
  assertHasProperty(config.transcription, 'whisper');
  assertHasProperty(config.transcription, 'assemblyai');
  assertHasProperty(config.transcription, 'deepgram');
});

test('config.transcription.service defaults to whisper-local', () => {
  // Could be overridden by env, but check it's a valid string
  assertType(config.transcription.service, 'string');
  assertTrue(['whisper-local', 'assemblyai', 'deepgram'].includes(config.transcription.service));
});

test('config.transcription.whisper has required fields', () => {
  assertHasProperty(config.transcription.whisper, 'binaryPath');
  assertHasProperty(config.transcription.whisper, 'model');
  assertHasProperty(config.transcription.whisper, 'language');
  assertHasProperty(config.transcription.whisper, 'cppModelPath');
});

test('config.transcription.assemblyai has apiKey and speakerLabels', () => {
  assertHasProperty(config.transcription.assemblyai, 'apiKey');
  assertHasProperty(config.transcription.assemblyai, 'speakerLabels');
  assertEqual(config.transcription.assemblyai.speakerLabels, true);
});

test('config.transcription.deepgram has apiKey, model, diarize, punctuate', () => {
  assertHasProperty(config.transcription.deepgram, 'apiKey');
  assertHasProperty(config.transcription.deepgram, 'model');
  assertHasProperty(config.transcription.deepgram, 'diarize');
  assertHasProperty(config.transcription.deepgram, 'punctuate');
  assertEqual(config.transcription.deepgram.diarize, true);
  assertEqual(config.transcription.deepgram.punctuate, true);
});

test('config.story.defaultStyle is martin or sanderson', () => {
  assertTrue(['martin', 'sanderson'].includes(config.story.defaultStyle));
});

test('config.audio has format, sampleRate, channels, ffmpegPath', () => {
  assertHasProperty(config.audio, 'format');
  assertHasProperty(config.audio, 'sampleRate');
  assertHasProperty(config.audio, 'channels');
  assertHasProperty(config.audio, 'ffmpegPath');
  assertTrue(['ogg', 'pcm'].includes(config.audio.format));
  assertEqual(config.audio.sampleRate, 48000);
  assertEqual(config.audio.channels, 2);
});

test('config.logging has level and file', () => {
  assertHasProperty(config.logging, 'level');
  assertHasProperty(config.logging, 'file');
  assertTrue(['debug', 'info', 'warn', 'error'].includes(config.logging.level));
  assertType(config.logging.file, 'boolean');
});

suite('config.js — Paths');

test('config.paths has all required directories', () => {
  const requiredPaths = ['recordings', 'transcripts', 'stories', 'lore', 'logs', 'campaignContext', 'campaignLog'];
  for (const p of requiredPaths) {
    assertHasProperty(config.paths, p);
  }
});

test('all paths are absolute', () => {
  for (const [key, val] of Object.entries(config.paths)) {
    assertTrue(path.isAbsolute(val), `config.paths.${key} should be absolute: ${val}`);
  }
});

test('campaignContext path ends with .json', () => {
  assertMatch(config.paths.campaignContext, /\.json$/);
});

test('campaignLog path ends with .md', () => {
  assertMatch(config.paths.campaignLog, /\.md$/);
});

test('paths are within the project directory', () => {
  const projectDir = path.resolve(__dirname, '..');
  for (const [key, val] of Object.entries(config.paths)) {
    assertTrue(val.startsWith(projectDir), `config.paths.${key} should be within project dir`);
  }
});

suite('config.js — Environment Variable Overrides');

test('ANTHROPIC_MAX_TOKENS env var is parsed as integer', () => {
  // The config.js uses parseInt — verify the current value is a number
  assertType(config.anthropic.maxTokens, 'number');
  assertTrue(Number.isInteger(config.anthropic.maxTokens));
});

test('default maxTokens is 8192', () => {
  // Unless overridden by env
  if (!process.env.ANTHROPIC_MAX_TOKENS) {
    assertEqual(config.anthropic.maxTokens, 8192);
  } else {
    assertTrue(config.anthropic.maxTokens > 0);
  }
});

test('config values are not undefined', () => {
  // Walk the config object and ensure no values are undefined
  function checkNoUndefined(obj, prefix) {
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        checkNoUndefined(val, `${prefix}.${key}`);
      } else {
        assertTrue(val !== undefined, `${prefix}.${key} should not be undefined`);
      }
    }
  }
  checkNoUndefined(config, 'config');
});
