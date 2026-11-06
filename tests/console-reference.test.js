import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(
  new URL("../examples/xdrive-queued-ci-cleanup.console.js", import.meta.url)
);
const script = readFileSync(file, "utf8");

test("user-verified console reference keeps its original cancellation defaults", () => {
  assert.match(script, /const root = "\/lazyxu\/xdrive"/);
  assert.match(script, /const workflow = "ci\.yml"/);
  assert.match(script, /const branch = "master"/);
  assert.match(script, /const maxPages = 40/);
  assert.match(script, /const maxCancel = 250/);
  assert.match(script, /const intervalMs = 600/);
  assert.match(script, /const candidates = old\.slice\(1\)\.filter\(x => x\.queued\)/);
  assert.match(script, /const protectedOld = old\[0\] \|\| null/);
  assert.match(script, /response\.status === 200 &&/);
  assert.match(script, /body\.includes\("successfully requested"\)/);
  assert.doesNotMatch(script, /api\.github\.com/);
  assert.doesNotMatch(script, /window\.confirm\(|\bconfirm\(|\bprompt\(/);
  assert.match(script, /window\.xdriveCancelResult = result/);
});

test("extension behavior is consistent with the verified workflow-level policy", () => {
  const operation = readFileSync(fileURLToPath(new URL(
    "../extensions/actions-sweeper/page-operations.js", import.meta.url
  )), "utf8");
  const popup = readFileSync(fileURLToPath(new URL(
    "../extensions/actions-sweeper/popup.js", import.meta.url
  )), "utf8");
  assert.match(operation, /queued: !metadataIncomplete && queueObserved/);
  assert.doesNotMatch(operation, /verifyNeverStarted|api\.github\.com/);
  assert.match(operation, /await getHead\(\)/);
  assert.match(operation, /const snapshot = await parsePage\(candidate\.page\)/);
  assert.match(popup, /if \(autoCancel && !stopRequested\)/);
  assert.match(popup, /await runCancellation\(\)\.catch/);
  assert.doesNotMatch(popup, /\bui\.cancel\b|\bui\.selectAll\b/);
});
