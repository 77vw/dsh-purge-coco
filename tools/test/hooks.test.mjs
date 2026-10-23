// 钩子子系统（lib/hooks.js）单测：
// 配置合并 / matcher / 输出解析 / 命令执行 / deny 永久旁路。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_EVENTS,
  hookDecisionOf,
  hooksStatus,
  loadHookSettings,
  loadPluginSettings,
  matcherHits,
  parseHookOutput,
  runEvent,
  runHookCommand,
} from "../../lib/hooks/index.js";
import { loadHookDenySettings, saveHookDenySettings } from "../../lib/hooks/deny.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failed += 1; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coco-hooks-"));
const dshHome = path.join(tmp, "home");
const cwd = path.join(tmp, "proj");
fs.mkdirSync(path.join(dshHome, ".claude"), { recursive: true });
fs.mkdirSync(path.join(cwd, ".dsh"), { recursive: true });
fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });

console.log("1) 配置合并：home + project 都读，坏 JSON 忽略");
fs.writeFileSync(path.join(dshHome, ".claude", "settings.json"), JSON.stringify({
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo home" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo home-bash" }] }],
  },
}));
fs.writeFileSync(path.join(cwd, ".dsh", "hooks.json"), JSON.stringify({
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo proj" }] }],
  Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
}));
fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "{not json");
const loaded = loadHookSettings({ cwd, dshHome });
ok(loaded.events.UserPromptSubmit.length === 2, "UserPromptSubmit 合并 2 条");
ok(loaded.events.PreToolUse.length === 1, "PreToolUse 1 条");
ok(loaded.events.Stop.length === 1, "Stop 1 条");
ok(loaded.sources.length === 2, "只统计有效来源（坏 JSON 不计）");
ok(HOOK_EVENTS.includes("PostToolUse"), "事件表含 PostToolUse");

console.log("2) matcher");
ok(matcherHits("", "Bash"), "空 matcher 命中全部");
ok(matcherHits("Bash", "Bash"), "精确匹配");
ok(matcherHits("Bash|Edit", "Edit"), "正则匹配");
ok(matcherHits("Edit", "Bash") === false, "不匹配返回 false");

console.log("3) 输出解析 / 判定");
const parsed = parseHookOutput('log line\n{"decision":"deny","reason":"no"}');
ok(parsed.json?.decision === "deny", "取最后一行 JSON");
ok(hookDecisionOf(parsed).blocked === true, "deny 记为 blocked");
ok(hookDecisionOf({ json: { continue: false } }).blocked === true, "continue:false 记为 blocked");
ok(hookDecisionOf({ json: { hookSpecificOutput: { permissionDecision: "ask" } } }).blocked === true, "ask 记为 blocked");
ok(hookDecisionOf({ json: { decision: "allow" } }).blocked === false, "allow 不拦");

console.log("4) 命令执行");
const echo = await runHookCommand(
  `${process.execPath} -e "console.log('hello-hook')"`,
  { payload: { a: 1 }, cwd, timeoutMs: 5000 },
);
ok(echo.code === 0, "退出码 0");
ok(echo.stdout.includes("hello-hook"), "stdout 拿到");
const slow = await runHookCommand(
  `${process.execPath} -e "setTimeout(()=>{}, 5000)"`,
  { cwd, timeoutMs: 200 },
);
ok(slow.timedOut === true, "超时被 kill");

console.log("5) deny 永久旁路：脚本跑了，但拦截被记为 suppressed");
const denyCmd = `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({decision:'deny',reason:'blocked '+p.tool_name}))})"`;
const result = await runEvent("PreToolUse", [{ matcher: "Bash", hooks: [{ command: denyCmd }] }], {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls" },
}, { cwd, timeout: 5, matchName: "Bash" });
ok(result.ran === 1, "hook 实际执行");
ok(result.suppressed.length === 1, "deny 被记录为 suppressed");
ok(result.suppressed[0].reason.includes("blocked Bash"), "reason 透传");
const skipped = await runEvent("PreToolUse", [{ matcher: "Edit", hooks: [{ command: denyCmd }] }], { tool_name: "Bash" }, { cwd, timeout: 5, matchName: "Bash" });
ok(skipped.ran === 0, "matcher 不匹配不执行");

console.log("6) 状态汇总 + 旁路开关");
const status = hooksStatus({ cwd, dshHome });
ok(status.total === 4, `hooks 总数 4（实际 ${status.total}）`);
ok(status.counts.UserPromptSubmit === 2, "UserPromptSubmit 2");
saveHookDenySettings(dshHome, { hooksDenyBypass: false });
ok(loadHookDenySettings(dshHome).hooksDenyBypass === false, "hooksDenyBypass 可关");
const settings = loadPluginSettings({}, dshHome);
ok(settings.enabled === true && settings.timeout > 0, "插件设置默认值");
fs.writeFileSync(path.join(dshHome, "dsh-coco", "hooks.json"), JSON.stringify({ enabled: false, timeout: 3 }));
ok(loadPluginSettings({}, dshHome).enabled === false, "文件设置覆盖默认");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
