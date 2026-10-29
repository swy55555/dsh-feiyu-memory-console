import fs from "node:fs";
import path from "node:path";
// null means unlimited: this file then records usage, never gates model calls.
export function reserveAppraisal(file, maxPerDay = null, now = Date.now()) {
  const maximum =
    maxPerDay === null
      ? null
      : Number.isFinite(Number(maxPerDay))
        ? Math.max(0, Math.min(100, Math.floor(Number(maxPerDay))))
        : 3;
  const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  let state = { day, count: 0 };
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !Number.isInteger(state.count) ||
      state.count < 0 ||
      typeof state.day !== "string"
    )
      throw Error("invalid quota");
  } catch (error) {
    if (error.code !== "ENOENT")
      return maximum === null
        ? { ok: true, maximum: null, count: null, counterAvailable: false }
        : { ok: false, reason: "budget-unavailable" };
  }
  if (state.day !== day) state = { day, count: 0 };
  if (maximum !== null && state.count >= maximum)
    return { ok: false, reason: "daily-limit", count: state.count, maximum };
  state.count++;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".stage", JSON.stringify(state) + "\n");
    fs.renameSync(file + ".stage", file);
  } catch {
    return maximum === null
      ? { ok: true, maximum: null, count: null, counterAvailable: false }
      : { ok: false, reason: "budget-unavailable" };
  }
  return { ok: true, count: state.count, maximum };
}
