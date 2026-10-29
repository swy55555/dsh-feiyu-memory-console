import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installRuntime } from "../bridge/install-runtime-bundle.mjs";
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
