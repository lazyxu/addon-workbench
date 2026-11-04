import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FAST_TERMINAL_PAGES, DEFAULT_FULL_MAX_PAGES, FAST_SCAN_HARD_CAP,
  scanLimitForMode, scanStopDecision } from '../extensions/actions-sweeper/scan-policy.js';

const check = (mode, page, streak, terminalPages, maxPages, lastPage = false) =>
  scanStopDecision({ mode, page, consecutiveTerminalPages: streak, terminalPages, maxPages, lastPage });

test('fast N defaults to 2, full maximum defaults to 20', () => {
  assert.equal(DEFAULT_FAST_TERMINAL_PAGES, 2);
  assert.equal(DEFAULT_FULL_MAX_PAGES, 20);
  assert.deepEqual(scanLimitForMode('fast', 2), { terminalPages: 2, maxPages: FAST_SCAN_HARD_CAP });
  assert.deepEqual(scanLimitForMode('full', 20), { terminalPages: null, maxPages: 20 });
});

test('fast respects configurable N consecutive terminal pages', () => {
  assert.equal(check('fast', 1, 1, 2, 100).done, false);
  assert.equal(check('fast', 2, 2, 2, 100).done, true);
  assert.equal(check('fast', 4, 2, 3, 100).done, false);
  assert.match(check('fast', 5, 3, 3, 100).reason, /连续 3 页终态/);
});

test('fast resets streak on active page and reports safety cap', () => {
  assert.equal(check('fast', 4, 0, 2, 100).done, false);
  assert.match(check('fast', 100, 0, 2, 100).reason, /安全上限/);
});

test('full ignores terminal streak, stops on configured limit or last page', () => {
  assert.equal(check('full', 2, 2, null, 20).done, false);
  assert.match(check('full', 20, 20, null, 20).reason, /完整扫描上限 20/);
  assert.equal(check('full', 11, 1, null, 20, true).reason, '到达最后一页');
});

test('validates inputs in either mode', () => {
  for (const bad of ['', 0, -1, 1.1, 101, 'x']) {
    assert.throws(() => scanLimitForMode('fast', bad), /页数/);
    assert.throws(() => scanLimitForMode('full', bad), /页数/);
  }
  assert.throws(() => scanLimitForMode('bad', 2), /未知扫描/);
});
