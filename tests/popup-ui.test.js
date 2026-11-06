import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = name => readFileSync(fileURLToPath(
  new URL("../extensions/actions-sweeper/" + name, import.meta.url)
), "utf8");

test("popup has no Dry Run checkbox or secondary confirmation UI", () => {
  const html = read("popup.html");
  const js = read("popup.js");
  for (const key of ["dryRun", "confirmation", "repoConfirmInput", "repoConfirmLabel",
    "confirmCancel", "dismissConfirm"]) {
    assert.doesNotMatch(html, new RegExp('id="' + key + '"'));
    assert.doesNotMatch(js, new RegExp("\\b" + key + "\\b"));
  }
  assert.doesNotMatch(html, /Dry Run|二次确认弹窗/);
  assert.match(html, /id="cancel"[^>]*disabled/);
  assert.match(html, /点击后立即逐条核验/);
});

test("cancellation is wired directly to a single click, never started by scanning", () => {
  const js = read("popup.js");
  assert.match(js, /ui\.cancel\.addEventListener\("click",[\s\S]*?runCancellation\(\)\.catch/);
  assert.match(js, /async function runCancellation\(\)/);
  assert.doesNotMatch(js, /isDryRun|window\.confirm|prompt\(/);
  const scanBody = js.slice(js.indexOf("  async function scan()"), js.indexOf("  async function saveHistory"));
  assert.ok(scanBody.length > 100);
  assert.doesNotMatch(scanBody, /runCancellation\(|op: "cancel-one"|\/suites\//);
});

test("manifest and popup explicitly agree on v0.1.6", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "0.1.6");
  assert.match(read("popup.html"), /class="version">v0\.1\.6</);
});
