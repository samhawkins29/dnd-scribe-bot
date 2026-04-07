#!/usr/bin/env node
/**
 * D&D Scribe Bot — Minimal Test Framework
 *
 * Assert-based runner with colored output, grouping, and summary.
 * No external dependencies needed.
 */

const assert = require('assert');
const path = require('path');

// ─── Colors (ANSI) ──────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

// ─── State ──────────────────────────────────────────────────────────
const failures = [];
const pendingTests = [];
const testResults = []; // { suite, description, passed }

let currentSuite = '';

// ─── Public API ─────────────────────────────────────────────────────

function suite(name) {
  currentSuite = name;
  console.log(`\n${c.cyan}${c.bright}━━━ ${name} ━━━${c.reset}`);
}

function test(description, fn) {
  const suiteName = currentSuite;
  const promise = (async () => {
    try {
      await fn();
      testResults.push({ suite: suiteName, passed: true });
      console.log(`  ${c.green}✓${c.reset} ${description}`);
    } catch (err) {
      const message = err.message || String(err);
      testResults.push({ suite: suiteName, passed: false });
      console.log(`  ${c.red}✗${c.reset} ${description}`);
      console.log(`    ${c.dim}${message.split('\n')[0]}${c.reset}`);
      failures.push({ suite: suiteName, test: description, error: message });
    }
  })();
  pendingTests.push(promise);
  return promise;
}

function skip(description) {
  testResults.push({ suite: currentSuite, passed: 'skip' });
  console.log(`  ${c.yellow}⊘${c.reset} ${c.dim}${description} (skipped)${c.reset}`);
}

// ─── Assertion Helpers ──────────────────────────────────────────────

function assertEqual(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertNotEqual(actual, notExpected, msg) {
  assert.notStrictEqual(actual, notExpected, msg);
}

function assertTrue(value, msg) {
  assert.ok(value, msg || `Expected truthy, got ${JSON.stringify(value)}`);
}

function assertFalse(value, msg) {
  assert.ok(!value, msg || `Expected falsy, got ${JSON.stringify(value)}`);
}

function assertThrows(fn, expectedMessage) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (expectedMessage && !err.message.includes(expectedMessage)) {
      throw new Error(`Expected error containing "${expectedMessage}", got "${err.message}"`);
    }
  }
  if (!threw) throw new Error(`Expected function to throw${expectedMessage ? ` "${expectedMessage}"` : ''}`);
}

async function assertThrowsAsync(fn, expectedMessage) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    if (expectedMessage && !err.message.includes(expectedMessage)) {
      throw new Error(`Expected error containing "${expectedMessage}", got "${err.message}"`);
    }
  }
  if (!threw) throw new Error(`Expected function to throw${expectedMessage ? ` "${expectedMessage}"` : ''}`);
}

function assertIncludes(str, substr, msg) {
  assertTrue(
    String(str).includes(substr),
    msg || `Expected "${String(str).slice(0, 100)}" to include "${substr}"`
  );
}

function assertMatch(str, regex, msg) {
  assertTrue(regex.test(str), msg || `Expected "${String(str).slice(0, 100)}" to match ${regex}`);
}

function assertType(value, type, msg) {
  assertEqual(typeof value, type, msg || `Expected type "${type}", got "${typeof value}"`);
}

function assertDeepEqual(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

function assertGreaterThan(actual, threshold, msg) {
  assertTrue(actual > threshold, msg || `Expected ${actual} > ${threshold}`);
}

function assertArray(value, msg) {
  assertTrue(Array.isArray(value), msg || `Expected array, got ${typeof value}`);
}

function assertHasProperty(obj, prop, msg) {
  assertTrue(prop in obj, msg || `Expected object to have property "${prop}"`);
}

// ─── Summary ────────────────────────────────────────────────────────

async function summary() {
  // Wait for all async tests to complete
  await Promise.all(pendingTests);

  // Compute per-suite stats
  const suiteMap = new Map();
  for (const r of testResults) {
    if (!suiteMap.has(r.suite)) suiteMap.set(r.suite, { passed: 0, failed: 0, skipped: 0 });
    const s = suiteMap.get(r.suite);
    if (r.passed === true) s.passed++;
    else if (r.passed === false) s.failed++;
    else s.skipped++;
  }

  const totalPassed = testResults.filter(r => r.passed === true).length;
  const totalFailed = testResults.filter(r => r.passed === false).length;
  const totalSkipped = testResults.filter(r => r.passed === 'skip').length;

  console.log(`\n${c.bright}${'═'.repeat(56)}${c.reset}`);
  console.log(`${c.bright}  TEST RESULTS${c.reset}`);
  console.log(`${'═'.repeat(56)}`);

  for (const [name, s] of suiteMap) {
    const icon = s.failed > 0 ? `${c.red}✗` : `${c.green}✓`;
    const counts = `${s.passed} passed${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}`;
    console.log(`  ${icon}${c.reset} ${name} — ${counts}`);
  }

  console.log(`${'─'.repeat(56)}`);
  console.log(`  ${c.green}Passed: ${totalPassed}${c.reset}  |  ${c.red}Failed: ${totalFailed}${c.reset}  |  ${c.yellow}Skipped: ${totalSkipped}${c.reset}  |  Total: ${totalPassed + totalFailed + totalSkipped}`);

  if (failures.length > 0) {
    console.log(`\n${c.red}${c.bright}  FAILURES:${c.reset}`);
    for (const f of failures) {
      console.log(`  ${c.red}✗${c.reset} [${f.suite}] ${f.test}`);
      console.log(`    ${c.dim}${f.error.split('\n')[0]}${c.reset}`);
    }
  }

  console.log(`${'═'.repeat(56)}`);
  const exitCode = totalFailed > 0 ? 1 : 0;
  console.log(totalFailed === 0
    ? `\n${c.green}${c.bright}  ALL TESTS PASSED${c.reset}\n`
    : `\n${c.red}${c.bright}  ${totalFailed} TEST(S) FAILED${c.reset}\n`
  );
  return exitCode;
}

module.exports = {
  suite, test, skip, summary,
  assertEqual, assertNotEqual, assertTrue, assertFalse,
  assertThrows, assertThrowsAsync, assertIncludes, assertMatch,
  assertType, assertDeepEqual, assertGreaterThan, assertArray,
  assertHasProperty,
};
