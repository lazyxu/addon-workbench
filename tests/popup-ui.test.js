import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = name => readFileSync(fileURLToPath(
  new URL("../extensions/actions-sweeper/" + name, import.meta.url)
), "utf8");

test("popup has a single scan-and-cancel action without dry-run or second confirmation", () => {
  const html = read("popup.html");
  const js = read("popup.js");
  for (const key of ["dryRun", "confirmation", "repoConfirmInput", "repoConfirmLabel",
    "confirmCancel", "dismissConfirm", "selectAll", "cancel"]) {
    assert.doesNotMatch(html, new RegExp('id="' + key + '"'));
  }
  assert.doesNotMatch(html, /Dry Run|请输入仓库名|确认取消/);
  assert.match(html, /id="scan"[^>]*>扫描并取消旧 CI/);
  assert.match(html, /扫描结束即开始逐条取消/);
  assert.match(html, /已开始的 Job 可能被中断/);
  assert.doesNotMatch(js, /\bui\.(?:cancel|selectAll)\b/);
});

test("verified scanning automatically starts cancellation only after a complete scan", () => {
  const js = read("popup.js");
  assert.match(js, /async function scan\(\)/);
  assert.match(js, /autoCancel = !stopRequested && selectedRuns\(\)\.length > 0/);
  assert.match(js, /if \(autoCancel && !stopRequested\)[\s\S]*?await runCancellation\(\)\.catch/);
  assert.match(js, /async function runCancellation\(\)/);
  assert.match(js, /ui\.scan\.addEventListener\("click", scan\)/);
  assert.doesNotMatch(js, /isDryRun|window\.confirm|prompt\(/);
  const scanning = js.slice(js.indexOf("  async function scan()"), js.indexOf("  async function saveHistory"));
  assert.ok(scanning.length > 500);
  assert.doesNotMatch(scanning, /op: "cancel-one"|\/suites\/|method:\s*"PUT"/);
});

test("popup, manifest and documentation advertise the same version", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "0.1.8");
  assert.match(read("popup.html"), /class="version">v0\.1\.8</);
});
