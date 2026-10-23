// 启动自检：五项判定 + 落盘 + 读取
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStartupCheck, readStartupCheck, reportPath } from "../../lib/engine/startup-check.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "coco-startup-"));

// 全绿
let r = await runStartupCheck({
  home,
  gatherState: async () => ({ patches_applied: 69, patches_total: 74, patches_skipped: 5 }),
  runtimeSnapshot: () => ({ approval: { ok: true }, escalation: { ok: true }, observation: { ok: true } }),
  presetIssues: () => [],
  guardReport: () => ({ confirmed: true, changed: 0, missing: 0 }),
  lastTier: () => ({ tier: "full", tokens: 6521 }),
});
ok("全绿 ok=5", r.ok === 5 && r.error === 0 && r.warn === 0, JSON.stringify(r.checks.patches));
ok("补丁明细含生效数", r.checks.patches.detail.includes("69/74"));

// 运行时缺两个
r = await runStartupCheck({
  home,
  gatherState: async () => ({ patches_applied: 69, patches_total: 74 }),
  runtimeSnapshot: () => ({ approval: { ok: true }, escalation: { ok: false } }),
  presetIssues: () => [],
  guardReport: () => null,
  lastTier: () => null,
});
ok("运行时缺失告警", r.checks.runtime.level === "warn" && r.checks.runtime.detail.includes("escalation"));
ok("未装配也告警", r.checks.inject.level === "warn");

// 预设冲突 = error
r = await runStartupCheck({
  home,
  gatherState: async () => ({ patches_applied: 1, patches_total: 2 }),
  runtimeSnapshot: () => ({ approval: { ok: true }, escalation: { ok: true }, observation: { ok: true } }),
  presetIssues: () => [{ preset: "redteam", line: 5, key: "toolFilter" }],
  guardReport: () => ({ confirmed: true, changed: 2, missing: 1 }),
  lastTier: () => ({ tier: "lite", tokens: 2000 }),
});
ok("预设冲突记 error", r.checks.presets.level === "error" && r.error >= 1);
ok("守卫不符记 error", r.checks.guard.level === "error");

// 落盘与读取
const fp = reportPath(home);
ok("报告落盘", fs.existsSync(fp));
ok("能读回同一份", readStartupCheck(home)?.total === 5);

// gatherState 抛错不炸
r = await runStartupCheck({
  home,
  gatherState: async () => { throw new Error("boom"); },
  runtimeSnapshot: () => ({}),
  presetIssues: () => [],
  guardReport: () => null,
  lastTier: () => null,
});
ok("gatherState 抛错时降级", r.checks.patches.level === "error");

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
