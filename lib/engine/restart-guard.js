import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * [dsh-coco] 重启守卫。
 *
 * 补丁改的是宿主自己的文件。改错了的直接后果是「宿主起不来」，而这时候插件也跑不起来，
 * 没有人能替你回滚——只能手动翻备份。这个模块负责留一条退路：
 *
 *   arm()        应用成功后、重启前，把每个被改文件的当前内容复制一份并记 sha256
 *   settle()     下一次启动时（插件激活）核对：文件还在不在、有没有被改回/改坏
 *   rollback()   一键把副本盖回去
 *   report()     给设置页看的摘要
 *
 * 不在启动时自动回滚：误判的代价比收益大。只报告，回滚由用户点。
 */
export function guardRoot(home) {
  return path.join(home, "dsh-coco", "restart-guard");
}
export function guardPath(home) {
  return path.join(guardRoot(home), "guard.json");
}

function sha256File(fp) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex"); } catch { return null; }
}

export function arm(home, files, note = "") {
  if (!home || !Array.isArray(files) || files.length === 0) return null;
  try {
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(guardRoot(home), id);
    fs.mkdirSync(dir, { recursive: true });
    const entries = [];
    files.forEach((fp, i) => {
      const before = sha256File(fp);
      if (!before) return;
      let copy = null;
      try {
        copy = path.join(dir, `${i}-${path.basename(fp)}`);
        fs.copyFileSync(fp, copy);
      } catch { copy = null; }
      entries.push({ file: fp, before, copy });
    });
    if (entries.length === 0) return null;
    const guard = { at: Date.now(), id, note, confirmed: false, entries };
    fs.mkdirSync(guardRoot(home), { recursive: true });
    fs.writeFileSync(guardPath(home), JSON.stringify(guard, null, 2), "utf8");
    return guard;
  } catch {
    return null;
  }
}

export function read(home) {
  try { return JSON.parse(fs.readFileSync(guardPath(home), "utf8")); } catch { return null; }
}

/** 启动时核对；只标记，不动文件。 */
export function settle(home) {
  const guard = read(home);
  if (!guard) return null;
  if (guard.confirmed) return { ...guard, settledNow: false };
  const changed = [];
  const missing = [];
  for (const e of guard.entries || []) {
    const now = sha256File(e.file);
    if (now === null) missing.push(e.file);
    else if (now !== e.before) changed.push(e.file);
  }
  const next = { ...guard, confirmed: true, settledAt: Date.now(), changed, missing, settledNow: true };
  try { fs.writeFileSync(guardPath(home), JSON.stringify(next, null, 2), "utf8"); } catch { /* 只读也能用 */ }
  return next;
}

export function rollback(home) {
  const guard = read(home);
  if (!guard) return { ok: false, error: "没有可回滚的记录" };
  const restored = [];
  const failed = [];
  for (const e of guard.entries || []) {
    if (!e.copy) { failed.push([e.file, "没有副本"]); continue; }
    try {
      fs.copyFileSync(e.copy, e.file);
      restored.push(e.file);
    } catch (err) {
      failed.push([e.file, String((err && err.message) || err)]);
    }
  }
  try {
    fs.writeFileSync(guardPath(home), JSON.stringify({ ...guard, reverted: true, revertedAt: Date.now() }, null, 2), "utf8");
  } catch { /* ignore */ }
  return { ok: failed.length === 0, restored, failed };
}

/** 设置页摘要：不带完整文件清单，只给计数与最近一次时间。 */
export function report(home) {
  const guard = read(home);
  if (!guard) return null;
  return {
    at: guard.at,
    confirmed: guard.confirmed === true,
    reverted: guard.reverted === true,
    files: (guard.entries || []).length,
    changed: (guard.changed || []).length,
    missing: (guard.missing || []).length,
    copyable: (guard.entries || []).filter((e) => e.copy).length,
  };
}
