#!/usr/bin/env node
/**
 * D&D Scribe Bot — Test Suite Runner
 *
 * Runs all test files in sequence and prints a combined summary.
 */

// Change to project root so requires work correctly
process.chdir(require('path').resolve(__dirname, '..'));

const testFiles = [
  './test-config.js',
  './test-logger.js',
  './test-transcribe.js',
  './test-generate-story.js',
  './test-pipeline.js',
  './test-dashboard-api.js',
  './test-campaign-context.js',
  './test-integration.js',
  './test-edge-cases.js',
];

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║         D&D Scribe Bot — Full Test Suite            ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  for (const file of testFiles) {
    try {
      require(file);
    } catch (err) {
      console.error(`\x1b[31mFailed to load ${file}: ${err.message}\x1b[0m`);
      console.error(err.stack);
    }
  }

  const { summary } = require('./test-runner');
  const exitCode = await summary();
  process.exit(exitCode);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
