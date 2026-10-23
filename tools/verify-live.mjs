#!/usr/bin/env node
/**
 * 真机验证：对着正在跑的宿主查一遍八阶段的落点。
 * 用法：node tools/verify-live.mjs [port]
 */
import { execSync } from "node:child_process";

function findPort() {
  try {
    const out = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep DeepSeek | grep -o '127.0.0.1:[0-9]*' | head -1", { encoding: "utf8" });
    const m = out.trim().match(/:(\d+)$/);
    if (m) return m[1];
  } catch { /* ignore */ }
  return "";
}

const port = process.argv[2] || findPort();
if (!port) { console.error("找不到宿主端口"); process.exit(1); }

const res = await fetch(`http://127.0.0.1:${port}/dsh-coco/status`, { headers: { host: `127.0.0.1:${port}` } });
if (res.status === 404) {
  console.error(`插件未加载：宿主 ${port} 上找不到 /dsh-coco/status。`);
  console.error("通常是插件入口 import 失败（死链 / 语法），先跑 node tools/test/plugin-load.test.mjs");
  process.exit(2);
}
const d = await res.json();

let failed = 0;
const ok = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); if (!cond) failed += 1; };

console.log(`宿主端口 ${port} · ${d.surface || "-"}\n`);

// 1 补丁
ok("补丁已生效", (d.patches_applied || 0) > 0, `${d.patches_applied}/${d.patches_total}`);
// 2 注入档位
ok("注入档位已记录", !!(d.inject_tier && d.inject_tier.tier), d.inject_tier ? `${d.inject_tier.tier} · ${d.inject_tier.tokens} tok` : "尚未装配（发一条消息）");
// 3 运行时层
const rt = d.runtime_layer || {};
const rtKeys = Object.keys(rt);
ok("运行时层已安装", rtKeys.length > 0, rtKeys.join(", ") || "无");
for (const k of rtKeys) ok(`运行时 ${k}`, !!(rt[k] && rt[k].ok), String((rt[k] && rt[k].detail) || ""));
// 4 退役
const sup = Object.entries(d.patch_status || {}).filter(([, v]) => v === "superseded").map(([k]) => k);
ok("文本补丁已退役", sup.length >= 2, sup.join(" "));
// 5 预设
ok("预设无冲突", Array.isArray(d.preset_health) && d.preset_health.length === 0, `${(d.preset_health || []).length} 处`);
// 6 hooks 策略
ok("hooks 策略已加载", !!(d.hooks_policy && d.hooks_policy.mode), d.hooks_policy ? d.hooks_policy.mode : "-");
// 7 自检
const sc = d.startup_check;
ok("启动自检已完成", !!sc, sc ? `${sc.ok}/${sc.total}` : "尚未生成");
if (sc) for (const [k, v] of Object.entries(sc.checks || {})) ok(`  自检 ${k}`, v.level !== "error", v.detail);

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
