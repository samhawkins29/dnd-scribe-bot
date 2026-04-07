/**
 * Simple structured logger with file + console output.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.logging.level] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function ensureLogDir() {
  if (!fs.existsSync(config.paths.logs)) {
    fs.mkdirSync(config.paths.logs, { recursive: true });
  }
}

function writeToFile(line) {
  if (!config.logging.file) return;
  ensureLogDir();
  const logFile = path.join(config.paths.logs, `bot-${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

function log(level, message, meta = {}) {
  if (LEVELS[level] < currentLevel) return;

  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `[${timestamp()}] [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;

  const consoleFn = level === 'error' ? console.error
    : level === 'warn' ? console.warn
    : console.log;
  consoleFn(line);
  writeToFile(line);
}

module.exports = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
