import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRuns, gitHubContext, normalizeWorkflow, normalizeBranch } from '../extensions/actions-sweeper/selection.js';
const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const earlier = 'c'.repeat(40);
const run = (id, sha, queued, stamp, suite = String(id), state) => ({
  id, sha, queued, suite,
  state: state || (queued ? 'WORKFLOW_RUN_STATUS_QUEUED' : 'WORKFLOW_RUN_STATUS_COMPLETED'),
  created: stamp, page: 1
});

test('selects only old queued; protects current head and newest older run', () => {
  const entries = [run(7, head, true, '2026-01-05T00:00:00Z'), run(6, old, true, '2026-01-04T00:00:00Z'),
    run(5, old, true, '2026-01-03T00:00:00Z'), run(4, earlier, false, '2026-01-02T00:00:00Z'),
    run(3, earlier, true, '2026-01-01T00:00:00Z')];
  const result = chooseRuns(entries, head);
  assert.deepEqual(result.eligible.map(x => x.id), [5, 3]);
  assert.equal(result.protectedLatestOld.id, 6);
  assert.equal(result.currentHead, 1);
  assert.equal(result.skippedNonQueued, 1);
});

test('skips queued runs without a cancellation suite', () => {
  const result = chooseRuns([run(4, old, true, '2026-01-04T00:00:00Z'),
    run(3, earlier, true, '2026-01-03T00:00:00Z', null)], head);
  assert.equal(result.eligible.length, 0);
  assert.equal(result.skippedNoCancelLink, 1);
});

test('fails when duplicate run data changes', () => {
  assert.throws(() => chooseRuns([
    run(7, earlier, true, '2026-01-04T00:00:00Z'),
    run(7, earlier, false, '2026-01-04T00:00:00Z')
  ], head), /数据不一致/);
});

test('rejects malformed head and foreign sites', () => {
  assert.throws(() => chooseRuns([], 'not-a-sha'), /HEAD/);
  assert.equal(gitHubContext('https://github.com.evil.com/acme/proj/actions'), null);
  assert.equal(gitHubContext('https://github.com/onlyowner'), null);
  assert.deepEqual(gitHubContext('https://github.com/acme/proj/actions/workflows/build.yml?query=branch%3Amaster'),
    {owner:'acme',repo:'proj',workflow:'build.yml',branch:'master'});
});

test('validates workflow filenames and Git branches', () => {
  assert.equal(normalizeWorkflow('.github/workflows/build.yaml'), 'build.yaml');
  assert.equal(normalizeBranch('feature/fix-actions'), 'feature/fix-actions');
  assert.throws(() => normalizeWorkflow('../oops.yml'), /工作流/);
  assert.throws(() => normalizeBranch('foo..bar'), /分支/);
  assert.throws(() => normalizeBranch('main branch'), /分支/);
});


test('unknown terminal metadata never becomes the protected latest-old or a candidate', () => {
  const result = chooseRuns([
    run(9, null, false, null),
    run(8, head, true, '2026-01-05T00:00:00Z'),
    run(7, old, true, '2026-01-04T00:00:00Z'),
    run(6, old, true, '2026-01-03T00:00:00Z'),
    run(5, earlier, false, '2026-01-02T00:00:00Z')
  ], head);
  assert.equal(result.total, 5);
  assert.equal(result.skippedMetadata, 1);
  assert.equal(result.currentHead, 1);
  assert.equal(result.protectedLatestOld.id, 7);
  assert.deepEqual(result.eligible.map(x => x.id), [6]);
  assert.equal(result.older, 3);
});

test('selection rejects unverified queued run even when supplied by another caller', () => {
  assert.throws(() => chooseRuns([run(3, null, true, null)], head), /缺少已验证的 SHA/);
});
