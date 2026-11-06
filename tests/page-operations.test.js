import test from 'node:test';
import assert from 'node:assert/strict';
import { pageOperation } from '../extensions/actions-sweeper/page-operations.js';
import { chooseRuns } from '../extensions/actions-sweeper/selection.js';

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

async function withPage({rows = [row()], sha = currentSha, status = 200, readStatus = 200,
  unrelatedQueuedText = false, omitDomAnchors = false, detailsStatus = 200,
  jobsResponse = { totalCount:1, nodes:[{id:321, name:'test job', status:'queued', conclusion:null}] },
  detailJSON = null }, fn) {
  const before = {fetch:globalThis.fetch, location:globalThis.location, DOMParser:globalThis.DOMParser};
  let sentCancel = 0;
  const reads = [];
  const detailReads = [];
  globalThis.location = { origin: 'https://github.com', pathname:'/example/repository/actions/workflows/build.yml' };
  globalThis.DOMParser = class {
    parseFromString(payload) {
      const parsed = JSON.parse(payload);
      const parsedRows = parsed.rows;
      return {querySelectorAll(selector) {
        if (selector === 'script[type="application/json"]') return [{textContent:JSON.stringify(
          parsedRows ? {workflowRunsRoute:{workflowRuns:parsedRows}} : parsed
        )}];
        if (selector === 'a[href*="/actions/runs/"]') return omitDomAnchors || !parsedRows ? [] : parsedRows.map(r => ({getAttribute:() => '/example/repository/actions/runs/' + r.id}));
        if (unrelatedQueuedText && selector.startsWith("span,")) return [{textContent:"Queued",childElementCount:0,getAttribute:() => null}];
        return [];
      }};
    }
  };
  globalThis.fetch = async (path, options={}) => {
    reads.push({path,options});
    if (path.endsWith('.atom')) return { ok:true, status:200, text:async () => atom(sha) };
    if (path.includes('/actions/workflows/build.yml?')) return { ok:readStatus === 200, status:readStatus,
      headers: {get: () => null}, text:async () => JSON.stringify({rows, unrelatedComponent: unrelatedQueuedText ? {text:"Queued"} : null}) };
    if (path === '/example/repository/actions/runs/123') {
      detailReads.push({path,options});
      return {
        ok: detailsStatus === 200, status: detailsStatus,
        headers:{ get: () => null },
        text:async () => JSON.stringify(detailJSON || {payload:{workflowRunJobsRoute:{jobs:jobsResponse}}})
      };
    }
    if (String(path).startsWith('https://api.github.com/')) {
      throw new Error('Cross-origin REST must not be used: ' + path);
    }
    if (path.endsWith('/suites/777/cancel')) {
      sentCancel++;
      return { status, text:async() => status === 200 ? '{"message":"successfully requested"}' : 'Unauthorized' };
    }
    throw Error('unexpected fetch ' + path);
  };
  try { return await fn({getSentCancel:() => sentCancel,reads,detailReads}); }
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


test('terminal page ignores unrelated hidden or embedded Queued text', async () => withPage({
  rows: Array.from({length:25}, (_, index) => ({...row('WORKFLOW_RUN_STATUS_COMPLETED'), id:1000 + index})),
  unrelatedQueuedText: true
}, async ctx => {
  const page = await pageOperation({op:'page',...input,page:1});
  assert.equal(page.total, 25);
  assert.equal(page.allRunsTerminal, true);
  assert.equal(page.domValidated, true);
  assert.equal(page.terminalPage, true);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('terminal page is not accepted when any listed run is queued', async () => withPage({
  rows: Array.from({length:25}, (_, index) => ({...row(index === 24 ? 'WORKFLOW_RUN_STATUS_QUEUED' : 'WORKFLOW_RUN_STATUS_COMPLETED'), id:2000 + index}))
}, async () => {
  const page = await pageOperation({op:'page',...input,page:1});
  assert.equal(page.allRunsTerminal, false);
  assert.equal(page.terminalPage, false);
}));


test('regression: completed CI run 42164508995 missing optional metadata never aborts page 1', async () => withPage({
  rows: [{ ...row('WORKFLOW_RUN_STATUS_COMPLETED'), id: 42164508995, description: null, createdAt: null }]
}, async ctx => {
  const page = await pageOperation({ op:'page', ...input, page:1 });
  assert.equal(page.__actionsSweeperError, undefined);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, 42164508995);
  assert.equal(page.items[0].sha, null);
  assert.equal(page.items[0].created, null);
  assert.equal(page.items[0].queued, false);
  assert.equal(page.incompleteTerminalRuns, 1);
  assert.equal(page.lastPage, true);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('completed row missing SHA does not prevent scanning known queued rows', async () => withPage({
  rows: [
    { ...row('WORKFLOW_RUN_STATUS_COMPLETED'), id: 42164508995, description: null },
    { ...row(), id: 42164508888 }
  ]
}, async () => {
  const page = await pageOperation({ op:'page', ...input, page:1 });
  assert.equal(page.items[0].queued, false);
  assert.equal(page.items[1].queued, true);
  assert.equal(page.items[1].sha, olderSha);
  assert.equal(page.incompleteTerminalRuns, 1);
}));

test('accepts alternate explicit SHA and created time on queued rows', async () => withPage({
  rows: [{ ...row(), description: null, headSha: olderSha, createdAt: { date: stamp } }]
}, async () => {
  const page = await pageOperation({ op:'page', ...input, page:1 });
  assert.equal(page.items[0].sha, olderSha);
  assert.equal(page.items[0].created, stamp);
  assert.equal(page.items[0].queued, true);
  assert.equal(page.incompleteTerminalRuns, 0);
}));

test('accepts same-origin absolute commit URL with query string', async () => withPage({
  rows: [{ ...row(), description: {linkUrl:'https://github.com/example/repository/commit/' + olderSha + '?check=1'} }]
}, async () => {
  const page = await pageOperation({ op:'page', ...input, page:1 });
  assert.equal(page.items[0].sha, olderSha);
}));

test('refuses queued runs with absent or conflicting SHA even with a cancel URL', async () => {
  for (const bad of [
    { ...row(), description: null },
    { ...row(), description: {linkUrl:'https://example.com/example/repository/commit/' + olderSha} },
    { ...row(), headSha: currentSha }
  ]) {
    await withPage({rows:[bad]}, async ctx => {
      const page = await pageOperation({op:'page', ...input, page:1});
      assert.equal(page.__actionsSweeperError, true);
      assert.match(page.message, /Run 数据不完整/);
      assert.equal(ctx.getSentCancel(), 0);
      const canceled = await pageOperation({op:'cancel-one', ...input, expectedHead:currentSha, candidate});
      assert.equal(canceled.__actionsSweeperError, true);
      assert.equal(ctx.getSentCancel(), 0);
    });
  }
});

test('refuses nonterminal run with missing timestamp and does not cancel', async () => withPage({
  rows: [{ ...row(), createdAt: null }]
}, async ctx => {
  const page = await pageOperation({op:'page', ...input, page:1});
  assert.equal(page.__actionsSweeperError, true);
  assert.match(page.message, /Run 数据不完整/);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('fully terminal page remains eligible for fast stop with optional metadata missing', async () => withPage({
  rows: Array.from({length:25}, (_, index) => ({
    ...row('WORKFLOW_RUN_STATUS_COMPLETED'), id: 42164508995 - index,
    description: null, createdAt: null
  }))
}, async () => {
  const page = await pageOperation({op:'page', ...input, page:1});
  assert.equal(page.allRunsTerminal, true);
  assert.equal(page.terminalPage, true);
  assert.equal(page.incompleteTerminalRuns, 25);
  assert.ok(page.items.every(item => !item.queued));
}));


test('queue label and cancellable confidence are distinct when timing reports running', async () => withPage({
  rows: [{ ...row('WORKFLOW_RUN_STATUS_QUEUED', 'Running'), id:42196976014 }]
}, async () => {
  const page = await pageOperation({op:'page', ...input, page:1});
  assert.equal(page.items[0].queueObserved, true);
  assert.equal(page.items[0].startedEvidence, true);
  assert.equal(page.items[0].queued, false);
  assert.equal(page.terminalPage, false);
}));

test('normalize unprefixed queued and in-progress states', async () => withPage({
  rows: [{...row(), state:null, status:'queued'}]
}, async () => {
  const page = await pageOperation({op:'page',...input,page:1});
  assert.equal(page.items[0].queueObserved, true);
  assert.equal(page.items[0].queued, true);
}));

test('completed conclusions are terminal even when GitHub uses SUCCESS/FAILURE names', async () => withPage({
  rows: Array.from({length:25}, (_, i) => ({
    ...row(['WORKFLOW_RUN_STATUS_SUCCESS','WORKFLOW_RUN_STATUS_FAILURE','WORKFLOW_RUN_STATUS_SKIPPED'][i%3]),
    id:3000+i,
    description:null,
    createdAt:null
  }))
}, async () => {
  const page = await pageOperation({op:'page', ...input, page:1});
  assert.equal(page.terminalPage, true);
  assert.equal(page.allRunsTerminal, true);
  assert.equal(page.incompleteTerminalRuns, 25);
  assert.ok(page.items.every(item => item.queued === false));
}));

test('fast terminal recognition works when GitHub page has no pre-rendered run anchors', async () => withPage({
  rows: Array.from({length:25}, (_, i) => ({...row('WORKFLOW_RUN_STATUS_COMPLETED'), id:4000+i})),
  omitDomAnchors:true
}, async () => {
  const page = await pageOperation({op:'page', ...input, page:1});
  assert.equal(page.domValidated, false);
  assert.equal(page.terminalPage, true);
  assert.equal(page.items.length, 25);
}));

test('unknown state does not stop fast scan prematurely', async () => withPage({
  rows: Array.from({length:25}, (_, i) => ({
    ...row(i===0 ? 'WORKFLOW_RUN_STATUS_SOMETHING_NEW' : 'WORKFLOW_RUN_STATUS_COMPLETED'),
    id:5000+i
  }))
}, async () => {
  const page = await pageOperation({op:'page', ...input, page:1});
  assert.equal(page.terminalPage, false);
  assert.equal(page.allRunsTerminal, false);
}));


test('never cancels when a queued workflow has a completed job in same-origin HTML', async () => withPage({
  jobsResponse:{totalCount:2,nodes:[
    {id:1,name:'pr-scope',status:'completed',conclusion:'success'},
    {id:2,name:'android-native',status:'queued',conclusion:null}
  ]}
}, async ctx => {
  const result = await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.__actionsSweeperError,true);
  assert.match(result.message,/Job 已开始\/完成/);
  assert.equal(ctx.getSentCancel(),0);
  assert.equal(ctx.detailReads.length,1);
  assert.equal(ctx.detailReads[0].path,'/example/repository/actions/runs/123');
  assert.equal(ctx.detailReads[0].options.credentials,'same-origin');
  assert.ok(ctx.reads.every(call => !String(call.path).startsWith('https://api.github.com/')));
}));

test('never cancels a queued workflow with in-progress job', async () => withPage({
  jobsResponse:{totalCount:1,nodes:[{id:2,name:'compile',status:'in_progress',conclusion:null}]}
}, async ctx => {
  const result=await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.__actionsSweeperError,true);
  assert.equal(ctx.getSentCancel(),0);
}));

test('never cancels if GitHub page is inaccessible or job metadata incomplete', async () => {
  for (const props of [
    {detailsStatus:403},
    {detailsStatus:429},
    {detailJSON:{payload:{workflowRunJobsRoute:{jobs:[]}}}},
    {jobsResponse:{totalCount:101,nodes:[]}},
    {jobsResponse:{totalCount:2,nodes:[{id:1,name:'job',status:'queued'}]}},
    {jobsResponse:{nodes:[{id:1,name:'job',status:'queued'}]}},
    {jobsResponse:{totalCount:1,nodes:[{id:1,name:'job'}]}},
    {detailJSON:{unrelated:{message:'Queued'}}}
  ]) {
    await withPage(props, async ctx=>{
      const result=await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
      assert.equal(result.__actionsSweeperError,true);
      assert.equal(ctx.getSentCancel(),0);
    });
  }
});

test('same-origin queued jobs allow preflight without REST', async () => withPage({
  jobsResponse:{totalCount:1,nodes:[{
    id:321,name:'waiting for runner',status:'queued',conclusion:null,
    started_at:stamp
  }]}
}, async ctx => {
  const result=await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.accepted,true);
  assert.equal(ctx.getSentCancel(),1);
  assert.equal(ctx.detailReads.length,1);
  assert.equal(ctx.detailReads[0].options.credentials,'same-origin');
  assert.ok(ctx.reads.every(call => !String(call.path).startsWith('https://api.github.com/')));
});

test('conflicting job lists and completed steps stop cancellation', async () => {
  for (const detailJSON of [
    {a:{jobs:{totalCount:1,nodes:[{id:1,name:'x',status:'queued'}]}},
     b:{jobs:{totalCount:1,nodes:[{id:1,name:'x',status:'completed'}]}}},
    {jobs:{totalCount:1,nodes:[{id:1,name:'x',status:'queued',
      steps:[{status:'completed'}]}]}}
  ]) {
    await withPage({detailJSON}, async ctx=>{
      const result=await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
      assert.equal(result.__actionsSweeperError,true);
      assert.equal(ctx.getSentCancel(),0);
    });
  }
});

test('GitHub real queue timer: Queued text with IN_PROGRESS kind is still queued', async () => withPage({
  rows: [{
    ...row('WORKFLOW_RUN_STATUS_QUEUED', 'Queued'),
    id: 42205760126,
    timing: {
      text: 'Queued',
      kind: 'WORKFLOW_RUN_TIMING_KIND_IN_PROGRESS'
    }
  }]
}, async ctx => {
  const page = await pageOperation({op:'page',...input,page:1});
  assert.equal(page.__actionsSweeperError, undefined);
  assert.equal(page.items[0].queueObserved, true);
  assert.equal(page.items[0].startedEvidence, false);
  assert.equal(page.items[0].queued, true);
  assert.equal(ctx.getSentCancel(), 0);
}));

test('real page-one distribution 21 queued + 4 completed yields nonzero initial candidates', async () => withPage({
  rows: [
    ...Array.from({length:21}, (_, i) => ({
      ...row('WORKFLOW_RUN_STATUS_QUEUED','Queued'),
      id: 42205760126 - i,
      timing: {
        text:'Queued',
        kind:'WORKFLOW_RUN_TIMING_KIND_IN_PROGRESS'
      }
    })),
    ...Array.from({length:4}, (_, i) => ({
      ...row('WORKFLOW_RUN_STATUS_COMPLETED','3h 58m 34s'),
      id: 42176673236 - i,
      timing: {
        text:'3h 58m 34s',
        kind:'WORKFLOW_RUN_TIMING_KIND_DURATION'
      }
    }))
  ]
}, async () => {
  const page = await pageOperation({op:'page',...input,page:1});
  assert.equal(page.total,25);
  assert.deepEqual(page.statuses,{QUEUED:21,COMPLETED:4});
  assert.equal(page.items.filter(item=>item.queueObserved).length,21);
  assert.equal(page.items.filter(item=>item.queued).length,21);
  assert.equal(page.terminalPage,false);
  const selection = chooseRuns(page.items,currentSha);
  assert.equal(selection.protectedLatestOld.id,42205760126);
  assert.equal(selection.eligible.length,20);
  assert.equal(selection.skippedNonQueued,4);
}));

test('queued workflow timer kind cannot bypass job-level refusal if a job completed', async () => withPage({
  rows:[{ ...row('WORKFLOW_RUN_STATUS_QUEUED','Queued'),
    timing:{text:'Queued',kind:'WORKFLOW_RUN_TIMING_KIND_IN_PROGRESS'}
  }],
  jobsResponse:{totalCount:2,nodes:[
    {id:1,name:'pr-scope',status:'completed',conclusion:'success'},
    {id:2,name:'build',status:'queued',conclusion:null}
  ]}
}, async ctx => {
  const snapshot=await pageOperation({op:'page',...input,page:1});
  assert.equal(snapshot.items[0].queued,true);
  const result=await pageOperation({op:'cancel-one',...input,expectedHead:currentSha,candidate});
  assert.equal(result.__actionsSweeperError,true);
  assert.match(result.message,/Job 已开始/);
  assert.equal(ctx.getSentCancel(),0);
}));
