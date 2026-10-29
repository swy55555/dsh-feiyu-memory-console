import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_VERSION = "0.8.11";
const files = {
  "memory-coverage.mjs": "memory-coverage.mjs",
  "idle-association.mjs": "idle-association.mjs",
  "daily-memory.js": "daily-memory.js",
  "fact-review.mjs": "fact-review.mjs",
  "bridge.js": "bridge-v09.js",
  "human-context.mjs": "human-context-v09.mjs",
  "emotion.js": "emotion.js",
  "emotion-appraisal.mjs": "emotion-appraisal.mjs",
  "turn-traces.mjs": "turn-traces.mjs",
  "emotion-context.mjs": "emotion-context.mjs",
  "appraisal-budget.mjs": "appraisal-budget.mjs",
};
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sourceHash = (file) =>
  digest(
    fs
      .readFileSync(file, "utf8")
      .replace(/^\uFEFF/, "")
      .replaceAll("\r\n", "\n"),
  );
const knownAuxiliary = { "daily-memory.js": "a71448afb1c6d23cf938b18ed618dd89fc5e4f6f7344d565a35bf754b14c9d17" };
const recognizedAuxiliary = (name, file) => knownAuxiliary[name] && sourceHash(file) === knownAuxiliary[name];
const receiptFile = (root) => path.join(root, "state", "runtime-bundle.json");
function receipt(root) {
  try {
    return JSON.parse(fs.readFileSync(receiptFile(root), "utf8"));
  } catch {
    return null;
  }
}
export function canManageRuntime(target) {
  const root = path.resolve(target);
  if (receipt(root)) return true;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(here, "runtime-known-versions.json"), "utf8"),
  );
  return manifest.some((version) =>
    Object.entries(version.files).every(([name, hash]) => {
      try {
        return sourceHash(path.join(root, "src", name)) === hash;
      } catch {
        return false;
      }
    }),
  );
}
export function installRuntime(
  target,
  mode = "check",
  { replaceLegacy = false } = {},
) {
  if (!["check", "apply", "undo"].includes(mode)) throw Error("invalid mode");
  const root = path.resolve(target),
    src = path.join(root, "src"),
    receiptPath = receiptFile(root);
  if (!fs.existsSync(path.join(src, "bridge.js")))
    throw Error("找不到目标 src/bridge.js");
  const previous = receipt(root);
  const rawHash = (file) =>
    fs.existsSync(file) ? digest(fs.readFileSync(file)) : null;
  const safeBackup = (name) => {
    if (typeof name !== "string" || !/^bundle-[a-zA-Z0-9-]+$/.test(name))
      throw Error("invalid backup directory");
    return path.join(root, ".runtime-backups", name);
  };
  if (mode === "undo") {
    if (!previous?.files) throw Error("没有运行时安装回执");
    const backup = safeBackup(previous.backup);
    for (const name of Object.keys(files)) {
      const record = previous.files[name];
      if (!record) throw Error("不完整的安装回执");
      if (rawHash(path.join(src, name)) !== record.afterHash)
        throw Error(`安装后 ${name} 有修改，拒绝覆盖`);
      if (
        record.existed &&
        rawHash(path.join(backup, name)) !== record.beforeHash
      )
        throw Error("备份校验失败");
    }
    const oldReceipt = path.join(backup, "previous-receipt.json");
    if (
      previous.hadReceipt &&
      rawHash(oldReceipt) !== previous.previousReceiptHash
    )
      throw Error("历史回执校验失败");
    for (const name of Object.keys(files)) {
      const file = path.join(src, name),
        record = previous.files[name];
      if (record.existed) fs.copyFileSync(path.join(backup, name), file);
      else fs.unlinkSync(file);
    }
    if (previous.hadReceipt) fs.copyFileSync(oldReceipt, receiptPath);
    else fs.unlinkSync(receiptPath);
    return { status: "restored", version: previous.version };
  }
  const identical = Object.entries(files).every(([name, source]) => {
    try {
      return (
        sourceHash(path.join(src, name)) === sourceHash(path.join(here, source))
      );
    } catch {
      return false;
    }
  });
  if (identical)
    return { status: "already-installed", version: RUNTIME_VERSION };
  if (previous?.files) {
    for (const [name, record] of Object.entries(previous.files)) {
      if (!Object.hasOwn(files, name)) throw Error("unknown managed file");
      if (rawHash(path.join(src, name)) !== record.afterHash)
        throw Error(`安装后 ${name} 有修改，未覆盖`);
    }
    for (const [name, source] of Object.entries(files)) {
      if (
        !previous.files[name] &&
        fs.existsSync(path.join(src, name)) &&
        sourceHash(path.join(src, name)) !== sourceHash(path.join(here, source)) &&
        !recognizedAuxiliary(name, path.join(src, name))
      )
        throw Error(`新增模块 ${name} 已存在自定义内容，未覆盖`);
    }
  } else if (!canManageRuntime(root) && !replaceLegacy)
    throw Error(
      "未知或自定义运行时：未覆盖。确认需要整份替换时使用 --replace-legacy（先备份）。",
    );
  for (const name of ["daily-memory.js", "fact-review.mjs", "idle-association.mjs", "memory-coverage.mjs"]) {
    const file = path.join(src, name);
    if (!replaceLegacy && !previous?.files?.[name] && fs.existsSync(file) &&
        sourceHash(file) !== sourceHash(path.join(here, files[name])) && !recognizedAuxiliary(name, file))
      throw Error(`辅助模块 ${name} 存在未知修改，未覆盖`);
  }
  for (const source of Object.values(files)) {
    const check = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      {
        input: fs.readFileSync(path.join(here, source), "utf8"),
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (check.status !== 0)
      throw Error(`模板语法错误 ${source}: ${check.stderr}`);
  }
  if (mode === "check")
    return { status: "compatible", version: RUNTIME_VERSION };
  const backupName = `bundle-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    backup = safeBackup(backupName);
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const result = {
    version: RUNTIME_VERSION,
    backup: backupName,
    hadReceipt: fs.existsSync(receiptPath),
    files: {},
  };
  if (result.hadReceipt) {
    fs.copyFileSync(receiptPath, path.join(backup, "previous-receipt.json"));
    result.previousReceiptHash = rawHash(receiptPath);
  }
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(src, name),
      existed = fs.existsSync(file);
    result.files[name] = {
      existed,
      beforeHash: rawHash(file),
      afterHash: rawHash(path.join(here, source)),
    };
    if (existed) fs.copyFileSync(file, path.join(backup, name));
  }
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(src, name),
        staged = `${file}.bundle-stage`;
      fs.copyFileSync(path.join(here, source), staged);
      fs.renameSync(staged, file);
      if (rawHash(file) !== result.files[name].afterHash)
        throw Error("安装写入校验失败");
    }
    fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    for (const name of Object.keys(files)) {
      const file = path.join(src, name);
      if (result.files[name].existed)
        fs.copyFileSync(path.join(backup, name), file);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
      if (fs.existsSync(`${file}.bundle-stage`))
        fs.unlinkSync(`${file}.bundle-stage`);
    }
    if (result.hadReceipt)
      fs.copyFileSync(path.join(backup, "previous-receipt.json"), receiptPath);
    else if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);
    throw error;
  }
  return {
    status: "installed",
    version: RUNTIME_VERSION,
    backup,
    restartRequired: true,
  };
}
