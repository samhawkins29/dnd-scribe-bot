#!/usr/bin/env node
/**
 * Tests for run-pipeline.js
 *
 * Tests pipeline sequencing, flag parsing, error propagation,
 * and file discovery WITHOUT running real transcription/generation.
 */

const fs = require('fs');
const path = require('path');
const {
  suite, test, assertEqual, assertTrue,
  assertThrowsAsync, assertIncludes, assertType, assertHasProperty,
} = require('./test-runner');

const config = require('../config');

suite('run-pipeline.js — Module Exports');

const pipelineModule = require('../run-pipeline');

test('module exports runPipeline function', () => {
  assertType(pipelineModule.runPipeline, 'function');
});

suite('run-pipeline.js — Source Code Analysis');

const pipelineSource = fs.readFileSync(path.resolve(__dirname, '../run-pipeline.js'), 'utf-8');

test('pipeline imports transcribe module', () => {
  assertIncludes(pipelineSource, "require('./transcribe')");
});

test('pipeline imports generate-story module', () => {
  assertIncludes(pipelineSource, "require('./generate-story')");
});

test('pipeline calls transcribe then generateStory in sequence', () => {
  // transcribe should come before generateStory in the code
  const transcribePos = pipelineSource.indexOf('await transcribe(');
  const generatePos = pipelineSource.indexOf('await generateStory(');
  assertTrue(transcribePos > 0, 'Should call transcribe()');
  assertTrue(generatePos > 0, 'Should call generateStory()');
  assertTrue(transcribePos < generatePos, 'transcribe should be called before generateStory');
});

test('pipeline passes transcription output to story generator', () => {
  // The transcriptPath from transcribe() should be passed to generateStory()
  assertIncludes(pipelineSource, 'generateStory(transcriptPath');
});

suite('run-pipeline.js — CLI Flag Parsing');

test('pipeline supports --latest flag', () => {
  assertIncludes(pipelineSource, "'--latest'");
  assertIncludes(pipelineSource, 'findLatestRecording()');
});

test('pipeline supports --style flag', () => {
  assertIncludes(pipelineSource, "'--style'");
});

test('pipeline supports --service flag for transcription override', () => {
  assertIncludes(pipelineSource, "'--service'");
});

test('pipeline supports --help flag', () => {
  assertIncludes(pipelineSource, "'--help'");
  assertIncludes(pipelineSource, "'-h'");
});

suite('run-pipeline.js — Error Propagation');

test('pipeline has try/catch for error handling', () => {
  assertIncludes(pipelineSource, 'catch (err)');
  assertIncludes(pipelineSource, 'Pipeline failed');
});

test('pipeline logs errors with stack trace', () => {
  assertIncludes(pipelineSource, 'err.stack');
});

test('runPipeline rejects with non-existent audio file', async () => {
  // Suppress console output during test
  const origLog = console.log;
  console.log = () => {};

  try {
    await assertThrowsAsync(
      () => pipelineModule.runPipeline('/nonexistent/fake.ogg'),
      'Audio file not found'
    );
  } finally {
    console.log = origLog;
  }
});

suite('run-pipeline.js — Pipeline Output');

test('pipeline returns transcriptPath and storyPath', () => {
  // Check the return statement in source
  assertIncludes(pipelineSource, 'transcriptPath');
  assertIncludes(pipelineSource, 'storyPath');
  assertIncludes(pipelineSource, 'summary');
  assertIncludes(pipelineSource, 'chapterNum');
});

test('pipeline outputs timing information', () => {
  assertIncludes(pipelineSource, 'elapsed');
  assertIncludes(pipelineSource, 'Pipeline complete in');
});

test('pipeline displays step progress', () => {
  assertIncludes(pipelineSource, 'Step 1/3');
  assertIncludes(pipelineSource, 'Step 2/3');
});
