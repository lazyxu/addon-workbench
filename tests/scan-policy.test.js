import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FAST_TERMINAL_PAGES, DEFAULT_FULL_MAX_PAGES, FAST_SCAN_HARD_CAP,
  GITHUB_FILTERED_RUN_LIMIT, GITHUB_MAX_FILTERED_PAGES, scanWorkflowPages,
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
  assert.match(check('fast', 40, 0, 2, 40).reason, /GitHub 单次查询上限/);
});

test('full ignores terminal streak, stops on configured limit or last page', () => {
  assert.equal(check('full', 2, 2, null, 20).done, false);
  assert.match(check('full', 20, 20, null, 20).reason, /完整扫描设定上限 20/);
  assert.equal(check('full', 11, 1, null, 20, true).reason, '到达最后一页');
});

test('validates inputs in either mode', () => {
  for (const bad of ['', 0, -1, 1.1, 41, 101, 'x']) {
    assert.throws(() => scanLimitForMode('fast', bad), /页数/);
    assert.throws(() => scanLimitForMode('full', bad), /页数/);
  }
  assert.throws(() => scanLimitForMode('bad', 2), /未知扫描/);
});


const mockPage = (page, opts = {}) => ({
  items: Array.from({ length: opts.count ?? 25 }, (_, i) => ({ id: (page - 1) * 25 + i + 1 })),
  terminalPage: Boolean(opts.terminalPage),
  lastPage: Boolean(opts.lastPage)
});

test('GitHub filtered query is capped at exactly 40 pages / 1000 runs', async () => {
  assert.equal(GITHUB_FILTERED_RUN_LIMIT, 1000);
  assert.equal(GITHUB_MAX_FILTERED_PAGES, 40);
  const requested = [];
  const result = await scanWorkflowPages(
    { mode: 'fast', ...scanLimitForMode('fast', 2) },
    async page => { requested.push(page); return mockPage(page); }
  );
  assert.equal(result.pages, 40);
  assert.equal(result.items.length, 1000);
  assert.equal(requested.includes(41), false);
  assert.match(result.reason, /GitHub 单次查询上限/);
  assert.equal(result.limited, true);
});

test('fast N stops after N consecutive terminal pages, resetting streak on activity', async () => {
  const pages = [];
  const result = await scanWorkflowPages(
    { mode: 'fast', ...scanLimitForMode('fast', 2) },
    async page => { pages.push(page); return mockPage(page, { terminalPage: [1, 3, 4].includes(page) }); }
  );
  assert.equal(result.pages, 4);
  assert.deepEqual(pages, [1, 2, 3, 4]);
  assert.match(result.reason, /连续 2 页终态/);
});

test('full scan stops at configured 20 pages, independent of terminal streak', async () => {
  const pages = [];
  const result = await scanWorkflowPages(
    { mode: 'full', ...scanLimitForMode('full', 20) },
    async page => { pages.push(page); return mockPage(page, { terminalPage: true }); }
  );
  assert.equal(result.pages, 20);
  assert.equal(pages.length, 20);
  assert.equal(result.items.length, 500);
  assert.match(result.reason, /设定上限 20 页/);
});

test('read errors keep the first six pages for read-only preview', async () => {
  await assert.rejects(
    scanWorkflowPages({ mode: 'fast', ...scanLimitForMode('fast', 2) },
      async page => {
        if (page === 7) throw new Error('HTTP 429');
        return mockPage(page);
      }
    ),
    error => {
      assert.equal(error.failedPage, 7);
      assert.equal(error.partialScan.pages, 6);
      assert.equal(error.partialScan.items.length, 150);
      assert.match(error.message, /HTTP 429/);
      return true;
    }
  );
});

test('empty last page terminates without attempting another page', async () => {
  const pages = [];
  const result = await scanWorkflowPages(
    { mode: 'full', ...scanLimitForMode('full', 20) },
    async page => { pages.push(page); return mockPage(page, { count: page === 3 ? 0 : 25, lastPage: page === 3 }); }
  );
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(result.pages, 3);
  assert.equal(result.reason, '到达最后一页');
});

test('duplicate page is rejected and partial data is retained', async () => {
  await assert.rejects(
    scanWorkflowPages({ mode: 'fast', ...scanLimitForMode('fast', 2) },
      async () => mockPage(1)
    ),
    error => {
      assert.equal(error.failedPage, 2);
      assert.equal(error.partialScan.pages, 1);
      assert.match(error.message, /重复分页/);
      return true;
    }
  );
});


test('live counts publish exactly once after each validated page', async () => {
  const updates = [];
  const result = await scanWorkflowPages(
    { mode:'full', ...scanLimitForMode('full', 20) },
    async page => mockPage(page, {count:page===3?3:25,lastPage:page===3}),
    {onPage: update => updates.push({
      page:update.page, pages:update.pages, total:update.items.length,
      lastPage:update.lastPage, done:update.decision.done
    })}
  );
  assert.deepEqual(updates, [
    {page:1,pages:1,total:25,lastPage:false,done:false},
    {page:2,pages:2,total:50,lastPage:false,done:false},
    {page:3,pages:3,total:53,lastPage:true,done:true}
  ]);
  assert.equal(result.items.length,53);
  assert.equal(result.pages,3);
});

test('failed page never emits a live update for unvalidated data', async () => {
  const updates = [];
  await assert.rejects(
    scanWorkflowPages({ mode:'full', ...scanLimitForMode('full', 20) },
      async page => page===2 ? {items:[{id:-1}],terminalPage:false,lastPage:false} : mockPage(page),
      {onPage: state => updates.push(state.page)}),
    error => error.failedPage===2 && error.partialScan.pages===1
  );
  assert.deepEqual(updates,[1]);
});

test('stop preserves already scanned pages for safe read-only preview', async () => {
  const pages=[];
  await assert.rejects(
    scanWorkflowPages({ mode:'full', ...scanLimitForMode('full', 20) },
      async page=>{pages.push(page);return mockPage(page);},
      {shouldStop:()=>pages.length>=2}),
    error=>{
      assert.match(error.message,/手动停止/);
      assert.equal(error.failedPage,3);
      assert.equal(error.partialScan.pages,2);
      assert.equal(error.partialScan.items.length,50);
      return true;
    }
  );
  assert.deepEqual(pages,[1,2]);
});
