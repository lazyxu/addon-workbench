import test from 'node:test';
import assert from 'node:assert/strict';
import { pageOperation } from '../extensions/actions-sweeper/page-operations.js';

const currentSha = 'a'.repeat(40);
const olderSha = 'b'.repeat(40);
const stamp = '2026-01-01T00:00:00Z';
const input = { owner:'example',repo:'repository',branch:'main',workflow:'build.yml' };
const atom = sha => '<feed><entry><id>tag:github.com,2008:Grit::Commit/' + sha + '</id></entry></feed>';
const row = (status = 'WORKFLOW_RUN_STATUS_QUEUED', timingText='') => ({
  id: 123, branch: { name:'refs/heads/main' }, workflowFilePath: '.github/workflows/build.yml',
  description: { linkUrl: '/example/repository/commit/' + olderSha },
  actions: { cancelUrl:'/example/repository/suites/777/cancel' },
  createdAt: { timestamp:stamp }, state:{status}, timing:{text:timingText,kind:''}
});

async function withPage({rows = [row()], sha = currentSha, status = 200, readStatus = 200}, fn) {
  const before = {fetch:globalThis.fetch, location:globalThis.location, DOMParser:globalThis.DOMParser};
  let sentCancel = 0;
  const reads = [];
  globalThis.location = { origin: 'https://github.com', pathname:'/example/repository/actions/workflows/build.yml' };
  globalThis.DOMParser = class {
    parseFromString(payload) {
      const {rows} = JSON.parse(payload);
      return {querySelectorAll(selector) {
        if (selector === 'script[type="application/json"]') return [{textContent:JSON.stringify({workflowRunsRoute:{workflowRuns:rows}})}];
        if (selector === 'a[href*="/actions/runs/"]') return rows.map(r => ({getAttribute:() => '/example/repository/actions/runs/' + r.id}));
        return [];
      }};
    }
  };
  globalThis.fetch = async (path, options={}) => {
    reads.push({path,options});
    if (path.endsWith('.atom')) return { ok:true, status:200, text:async () => atom(sha) };
    if (path.includes('/actions/workflows/build.yml?')) return { ok:readStatus === 200, status:readStatus,
      headers: {get: () => null}, text:async () => JSON.stringify({rows}) };
    if (path.endsWith('/suites/777/cancel')) {
      sentCancel++;
      return { status, text:async() => status === 200 ? '{"message":"successfully requested"}' : 'Unauthorized' };
    }
    throw Error('unexpected fetch ' + path);
  };
  try { return await fn({getSentCancel:() => sentCancel,reads}); }
  finally { Object.assign(globalThis, before); }
}

const candidate = {id:123,sha:olderSha,suite:'777',created:stamp,page:1};

test('reads branch HEAD without modifying actions', async () => withPage({}, async ctx => {
  assert.deepEqual(await pageOperation({op:'head',...input}), {head:currentSha});
  assert.equal(ctx.getSentCancel(), 0);
}));

test('parses queued run from workflow page', async () => withPage({}, async ctx => {
  const page = await pageOperation({op:'page',...input,page:1});
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].queued, true);
  assert.equal(page.items[0].suite, '777');
  assert.equal(ctx.getSentCancel(), 0);
}));

test('requests cancellation of revalidated queued old run', async () => withPage({}, async ctx => {
  const result = await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.accepted, true);
  assert.equal(ctx.getSentCancel(), 1);
  assert.equal(ctx.reads.at(-1).options.method, 'PUT');
}));

test('refuses an already-running job', async () => withPage({rows:[row('WORKFLOW_RUN_STATUS_IN_PROGRESS','Running')]}, async ctx => {
  const result = await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.__actionsSweeperError, true);
  assert.match(result.message, /安全停止/);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('refuses a changed HEAD', async () => withPage({sha:'c'.repeat(40)}, async ctx => {
  const result = await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.__actionsSweeperError, true);
  assert.match(result.message, /HEAD 已变化/);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('refuses a finished or moved run', async () => withPage({rows:[row('WORKFLOW_RUN_STATUS_COMPLETED')]}, async ctx => {
  const result = await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.__actionsSweeperError, true);
  assert.match(result.message, /安全停止/);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('returns authentication failure without success', async () => withPage({status:403}, async ctx => {
  const result = await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.accepted, false);
  assert.equal(result.authOrRateLimited, true);
  assert.equal(ctx.getSentCancel(), 1);
}));

test('rejects foreign repository without network request', async () => withPage({}, async ctx => {
  const result = await pageOperation({op:'head',...input,repo:'another'});
  assert.equal(result.__actionsSweeperError, true);
  assert.match(result.message, /已经切换仓库/);
  assert.equal(ctx.reads.length, 0);
}));


test('GitHub HTTP 429 returns a serialized, retryable diagnostic without cancellation', async () => withPage({readStatus:429}, async ctx => {
  const result = await pageOperation({op:'page',...input,page:41});
  assert.equal(result.__actionsSweeperError, true);
  assert.equal(result.httpStatus, 429);
  assert.equal(result.retryable, true);
  assert.match(result.message, /HTTP 429/);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('GitHub HTTP 403 without rate-limit headers is not retried', async () => withPage({readStatus:403}, async () => {
  const result = await pageOperation({op:'page',...input,page:3});
  assert.equal(result.httpStatus, 403);
  assert.equal(result.retryable, false);
}));

test('HTTP 500 is exposed as retryable page failure', async () => withPage({readStatus:500}, async () => {
  const result = await pageOperation({op:'page',...input,page:2});
  assert.equal(result.httpStatus, 500);
  assert.equal(result.retryable, true);
}));
