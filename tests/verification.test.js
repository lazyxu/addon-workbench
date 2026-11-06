import test from "node:test";
import assert from "node:assert/strict";
import { cancellationState, verifyCancellationResults } from "../extensions/actions-sweeper/verification.js";

test("final cancellation must be explicitly cancelled, not merely accepted/completed", () => {
  assert.equal(cancellationState({state:"WORKFLOW_RUN_STATUS_CANCELLED"}),"confirmed");
  assert.equal(cancellationState({state:"WORKFLOW_RUN_STATUS_COMPLETED",
    conclusion:"WORKFLOW_RUN_CONCLUSION_CANCELLED"}),"confirmed");
  assert.equal(cancellationState({state:"WORKFLOW_RUN_STATUS_COMPLETED",
    conclusion:"WORKFLOW_RUN_CONCLUSION_SUCCESS"}),"finished-other");
  assert.equal(cancellationState({state:"WORKFLOW_RUN_STATUS_COMPLETED"}),"pending");
  assert.equal(cancellationState({state:"WORKFLOW_RUN_STATUS_QUEUED"}),"pending");
  assert.equal(cancellationState(null),"unknown");
});

test("read-only verification retries and confirms cancellation without guessing", async () => {
  const updates = [];
  let reads = 0;
  const result = await verifyCancellationResults([{id:7,page:2}],async page => {
    assert.equal(page,2);
    reads++;
    return {items:[{id:7,state:reads===1?
      "WORKFLOW_RUN_STATUS_QUEUED":"WORKFLOW_RUN_STATUS_COMPLETED",
      conclusion:reads===1?null:"WORKFLOW_RUN_CONCLUSION_CANCELLED"}]};
  },{rounds:4,pause:async()=>{},onProgress:r=>updates.push(r)});
  assert.equal(result.accepted,1);
  assert.equal(result.confirmed,1);
  assert.equal(result.unconfirmed,0);
  assert.equal(reads,2);
  assert.equal(updates.length,2);
});

test("finished success cannot masquerade as cancellation", async () => {
  const result=await verifyCancellationResults([{id:9,page:1}],async () => ({
    items:[{id:9,state:"WORKFLOW_RUN_STATUS_COMPLETED",conclusion:"SUCCESS"}]
  }),{rounds:2});
  assert.equal(result.confirmed,0);
  assert.equal(result.finishedOther,1);
  assert.equal(result.unconfirmed,0);
  assert.deepEqual(result.finishedOtherIds,[9]);
});

test("Completed without conclusion stays unconfirmed after all attempts", async () => {
  let attempts=0;
  const result=await verifyCancellationResults([{id:12,page:1}],async ()=> {
    attempts++;
    return {items:[{id:12,state:"WORKFLOW_RUN_STATUS_COMPLETED"}]};
  },{rounds:3,pause:async()=>{}});
  assert.equal(result.confirmed,0);
  assert.equal(result.unconfirmed,1);
  assert.equal(attempts,3);
});

test("when a run shifts to adjacent page, verification still finds it", async () => {
  const seen=[];
  const result=await verifyCancellationResults([{id:14,page:2}],async page => {
    seen.push(page);
    return {items:page===1?[{id:14,state:"WORKFLOW_RUN_STATUS_CANCELLED"}]:[]};
  },{rounds:1});
  assert.deepEqual(seen,[2,1,3]);
  assert.equal(result.confirmed,1);
});

test("network or parsing errors cannot falsely confirm cancellation", async () => {
  const result=await verifyCancellationResults([{id:21,page:1}],async()=>{
    throw new Error("HTTP 429");
  },{rounds:2,pause:async()=>{}});
  assert.equal(result.confirmed,0);
  assert.equal(result.unconfirmed,1);
});

test("invalid duplicate Run IDs in request are rejected", async () => {
  await assert.rejects(
    verifyCancellationResults([{id:3,page:1},{id:3,page:2}],async()=>({items:[]})),
    /无效或重复 Run/
  );
});

test("progress and cancellation verification are read-only", async () => {
  const calls=[];
  const runs=[{id:31,page:1},{id:32,page:2}];
  const result=await verifyCancellationResults(runs,async page=>{
    calls.push(page);
    return {items:page===1?[{id:31,state:"CANCELLED"}]:
      [{id:32,state:"COMPLETED",conclusion:"SUCCESS"}]};
  },{rounds:1});
  assert.equal(result.confirmed,1);
  assert.equal(result.finishedOther,1);
  assert.deepEqual(calls,[1,2]);
});
