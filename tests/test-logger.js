#!/usr/bin/env node
/**
 * Tests for logger.js
 */

const fs = require('fs');
const path = require('path');
const {
  suite, test, assertTrue, assertIncludes, assertMatch, assertType,
} = require('./test-runner');

const config = require('../config');

suite('logger.js — Module Structure');

const logger = require('../logger');

test('logger exports debug, info, warn, error functions', () => {
  assertType(logger.debug, 'function');
  assertType(logger.info, 'function');
  assertType(logger.warn, 'function');
  assertType(logger.error, 'function');
});

suite('logger.js — Console Output');

test('info() produces output (captured)', () => {
  // Capture console.log
  const original = console.log;
  let captured = '';
  console.log = (...args) => { captured += args.join(' '); };

  logger.info('test message from unit test');

  console.log = original;
  assertIncludes(captured, 'test message from unit test');
  assertIncludes(captured, 'INFO');
});

test('error() uses console.error', () => {
  const original = console.error;
  let captured = '';
  console.error = (...args) => { captured += args.join(' '); };

  logger.error('error test message');

  console.error = original;
  assertIncludes(captured, 'error test message');
  assertIncludes(captured, 'ERROR');
});

test('warn() uses console.warn', () => {
  const original = console.warn;
  let captured = '';
  console.warn = (...args) => { captured += args.join(' '); };

  logger.warn('warn test message');

  console.warn = original;
  assertIncludes(captured, 'warn test message');
  assertIncludes(captured, 'WARN');
});

test('log output includes ISO timestamp', () => {
  const original = console.log;
  let captured = '';
  console.log = (...args) => { captured += args.join(' '); };

  logger.info('timestamp test');

  console.log = original;
  // ISO date pattern like 2026-04-01T...
  assertMatch(captured, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('log output includes metadata as JSON', () => {
  const original = console.log;
  let captured = '';
  console.log = (...args) => { captured += args.join(' '); };

  logger.info('meta test', { key: 'value', num: 42 });

  console.log = original;
  assertIncludes(captured, '"key":"value"');
  assertIncludes(captured, '"num":42');
});

test('log without metadata has no trailing JSON', () => {
  const original = console.log;
  let captured = '';
  console.log = (...args) => { captured += args.join(' '); };

  logger.info('no meta test');

  console.log = original;
  // Should end with the message, not with {}
  assertTrue(!captured.includes('{}'));
});

suite('logger.js — File Output');

test('logger writes to log file when config.logging.file is true', () => {
  // Force a log entry
  const original = console.log;
  console.log = () => {};
  logger.info('file output test marker xyz123');
  console.log = original;

  // Check for today's log file
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(config.paths.logs, `bot-${today}.log`);

  assertTrue(fs.existsSync(logFile), `Log file should exist: ${logFile}`);

  const content = fs.readFileSync(logFile, 'utf-8');
  assertIncludes(content, 'file output test marker xyz123');
});

test('log file contains properly formatted lines', () => {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(config.paths.logs, `bot-${today}.log`);

  if (!fs.existsSync(logFile)) return; // skip if no log file

  const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
  assertTrue(lines.length > 0, 'Log file should have at least one line');

  // Each line should start with [timestamp] [LEVEL]
  const lastLine = lines[lines.length - 1];
  assertMatch(lastLine, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*\] \[(DEBUG|INFO |WARN |ERROR)\]/);
});

suite('logger.js — Log Level Filtering');

test('debug messages are filtered when level is info', () => {
  // If current level is info or higher, debug should be suppressed
  if (config.logging.level !== 'debug') {
    const original = console.log;
    let captured = '';
    console.log = (...args) => { captured += args.join(' '); };

    logger.debug('this should not appear in info mode');

    console.log = original;
    assertTrue(captured === '', 'Debug message should be filtered at info level');
  } else {
    // If debug level, this test isn't meaningful
    assertTrue(true);
  }
});
