import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installRuntime, RUNTIME_VERSION } from "../bridge/install-runtime-bundle.mjs";
test("bundle requires known hashes, updates dependencies, is idempotent and reversibly protects edits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feiyu-bundle-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    const target = path.join(dir, "src", "bridge.js");
    fs.writeFileSync(target, "export const custom = true;\n");
    assert.throws(() => installRuntime(dir, "apply"), /未知/);
    assert.equal(
      installRuntime(dir, "check", { replaceLegacy: true }).status,
      "compatible",
    );
    assert.ok(!fs.existsSync(path.join(dir, ".runtime-backups")));
    assert.equal(
      installRuntime(dir, "apply", { replaceLegacy: true }).status,
      "installed",
    );
    assert.equal(installRuntime(dir, "apply").status, "already-installed");
    for (const f of [
      "emotion.js",
      "emotion-appraisal.mjs",
      "emotion-context.mjs",
      "appraisal-budget.mjs",
      "turn-traces.mjs",
      "human-context.mjs",
    ])
      assert.ok(fs.existsSync(path.join(dir, "src", f)));
    const installed = fs.readFileSync(target);
    fs.appendFileSync(target, "\n// local change");
    assert.throws(() => installRuntime(dir, "apply"), /修改/);
    assert.throws(() => installRuntime(dir, "undo"), /修改/);
    fs.writeFileSync(target, installed);
    assert.equal(installRuntime(dir, "undo").status, "restored");
    assert.equal(
      fs.readFileSync(target, "utf8"),
      "export const custom = true;\n",
    );
    assert.ok(!fs.existsSync(path.join(dir, "src", "emotion-appraisal.mjs")));
  } finally {
    const rel = path.relative(os.tmpdir(), dir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a version-only upgrade updates the receipt and restores the previous receipt on undo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feiyu-bundle-version-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "bridge.js"), "export const initial = true;\n");
    assert.equal(installRuntime(dir, "apply", { replaceLegacy: true }).status, "installed");
    const rp = path.join(dir, "state", "runtime-bundle.json");
    const old = JSON.parse(fs.readFileSync(rp, "utf8"));
    old.version = "0.8.12-preview.3";
    const before = JSON.stringify(old);
    fs.writeFileSync(rp, before);
    const bytes = fs.readFileSync(path.join(dir, "src", "bridge.js"));
    assert.equal(installRuntime(dir, "check").status, "compatible");
    assert.equal(fs.readFileSync(rp, "utf8"), before);
    assert.equal(installRuntime(dir, "apply").status, "installed");
    assert.equal(JSON.parse(fs.readFileSync(rp, "utf8")).version, RUNTIME_VERSION);
    assert.deepEqual(fs.readFileSync(path.join(dir, "src", "bridge.js")), bytes);
    assert.equal(installRuntime(dir, "apply").status, "already-installed");
    assert.equal(installRuntime(dir, "undo").status, "restored");
    assert.equal(fs.readFileSync(rp, "utf8"), before);
  } finally {
    const rel = path.relative(os.tmpdir(), dir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) fs.rmSync(dir, { recursive: true, force: true });
  }
});
