/**
 * 启动自检（第 7 阶段）
 *
 * 插件起来后跑一次五项检查，结果落盘，页面顶部一屏看完：
 *   1 补丁      有多少条能定位 / 多少条无载体
 *   2 注入      上一次装配用的档位与 token
 *   3 运行时层  审批/升级/观察三个代理装了没
 *   4 预设契约  有没有宿主已删字段残留（会导致模式加载失败）
 *   5 重启守卫  上次重启是否确认过
 *
 * 只读、只报告，不改任何东西；任何一项异常都不阻断启动。
 */
import fs from "node:fs";
import path from "node:path";

export function reportPath(home) {
  return path.join(home, "dsh-coco", "startup-check.json");
}

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

/**
 * @param {object} deps 由调用方注入，避免这里 import core 造成循环依赖
 */
export async function runStartupCheck(deps) {
  const { home, gatherState, runtimeSnapshot, presetIssues, guardReport, lastTier } = deps;
  const checks = {};

  // 1 补丁
  let state = null;
  try { state = await gatherState(); } catch { state = null; }
  if (state) {
    const applied = Number(state.patches_applied || 0);
    const total = Number(state.patches_total || 0);
    checks.patches = {
      ok: total > 0 && applied > 0,
      detail: `${applied}/${total} 生效 · ${state.patches_skipped || 0} 无载体`,
      level: applied === 0 && total > 0 ? "error" : "ok",
    };
  } else {
    checks.patches = { ok: false, detail: "读不到宿主状态", level: "error" };
  }

  // 2 注入档位（启动时还没装配过，退回读上一次的快照）
  const tier = safe(() => lastTier(), null);
  if (tier) {
    checks.inject = { ok: true, detail: `${tier.tier} · ${tier.tokens} tok`, level: "ok" };
  } else {
    const snap = safe(() => JSON.parse(fs.readFileSync(path.join(home, "dsh-coco", "last-assembly.json"), "utf8")), null);
    checks.inject = snap && snap.injectBytes
      ? { ok: true, detail: `上次装配 ${(Number(snap.injectBytes) / 1024).toFixed(1)} KB`, level: "ok" }
      : { ok: false, detail: "尚未装配（发一条消息后更新）", level: "warn" };
  }

  // 3 运行时层
  const rt = safe(() => runtimeSnapshot(), {}) || {};
  const wanted = Object.keys(rt);
  const missing = wanted.filter((k) => !(rt[k] && rt[k].ok));
  checks.runtime = wanted.length === 0
    ? { ok: false, detail: "未安装（等你重启后生效）", level: "warn" }
    : {
      ok: missing.length === 0,
      detail: missing.length ? `未接管：${missing.join(", ")}` : `${wanted.length}/${wanted.length} 已接管`,
      level: missing.length ? "warn" : "ok",
    };

  // 4 预设契约
  const issues = safe(() => presetIssues(), []) || [];
  checks.presets = {
    ok: issues.length === 0,
    detail: issues.length ? `${issues.length} 处不兼容` : "无冲突",
    level: issues.length ? "error" : "ok",
  };

  // 5 重启守卫
  const guard = safe(() => guardReport(), null);
  if (!guard) {
    checks.guard = { ok: true, detail: "没有待确认的重启", level: "ok" };
  } else if (guard.reverted) {
    checks.guard = { ok: false, detail: "已回滚", level: "warn" };
  } else if (guard.confirmed && (guard.changed || guard.missing)) {
    checks.guard = { ok: false, detail: `${guard.changed || 0} 改动 / ${guard.missing || 0} 缺失`, level: "error" };
  } else {
    checks.guard = { ok: true, detail: guard.confirmed ? "上次重启正常" : "等待重启确认", level: "ok" };
  }

  // 旁路层：补丁按"拆掉哪层防线"归类的汇总
  if (state && state.patch_status) {
    try {
      const { layerReport: lr, layerSummary: ls } = await import("./layers.js");
      const rows = lr(state.patch_status);
      const sum = ls(rows);
      checks.layers = {
        ok: sum.partial === 0,
        detail: `${sum.full}/${sum.total} 层完整` + (sum.partial ? ` · ${sum.partial} 层缺口` : ""),
        level: sum.partial ? "warn" : "ok",
      };
    } catch { /* 忽略 */ }
  }

  const list = Object.values(checks);
  const report = {
    at: Date.now(),
    ok: list.filter((c) => c.ok).length,
    total: list.length,
    error: list.filter((c) => c.level === "error").length,
    warn: list.filter((c) => c.level === "warn").length,
    checks,
  };
  try {
    fs.mkdirSync(path.dirname(reportPath(home)), { recursive: true });
    fs.writeFileSync(reportPath(home), JSON.stringify(report, null, 2), "utf8");
  } catch { /* 落盘失败不影响 */ }
  return report;
}

export function readStartupCheck(home) {
  try { return JSON.parse(fs.readFileSync(reportPath(home), "utf8")); } catch { return null; }
}
