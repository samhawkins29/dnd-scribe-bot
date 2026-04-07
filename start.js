#!/usr/bin/env node
/**
 * Cross-platform launcher — starts the dashboard server
 * and opens the browser automatically.
 */

const { exec } = require('child_process');
const path = require('path');

// Open browser after a short delay
const url = 'http://localhost:3000';
setTimeout(() => {
  const cmd = process.platform === 'win32' ? `start ${url}`
    : process.platform === 'darwin' ? `open ${url}`
    : `xdg-open ${url}`;
  exec(cmd, () => {});
}, 2000);

// Start the server
require('./dashboard/server');
