// 装配路径冒烟：走一遍 rewriteLiveAssembly，防止「变量先用后声明」这类 TDZ 事故。
// 上一轮 skipSnapshot: subagent 就是这么挂的（subagent 在其后才 let 声明）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "coco-asm-"));
process.env.DSH_HOME = home;
fs.mkdirSync(path.join(home, "dsh-coco"), { recursive: true });
fs.writeFileSync(path.join(home, "prompt-inject.md"), "## 核心\n\n你是测试体。\n\n## Routing\n\n路由段。\n", "utf8");

const { rewriteLiveAssembly } = await import("../../lib/index.js");

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const assembled = {
  sections: [{ name: "deployment:persona-prefix", text: "BASE" }, { name: "time-context", text: "now" }],
  contexts: [], tools: [],
};
const ctx = { agent: { session: { header: { cwd: home } } }, session: { header: { cwd: home } } };

let out = null;
try {
  out = rewriteLiveAssembly({ enabled: true }, assembled, ctx, { mode: "full", taskKind: "general" });
  ok("装配不抛错", true);
} catch (e) {
  ok("装配不抛错", false, String(e && e.message));
}

if (out) {
  ok("返回 sections", Array.isArray(out.sections) && out.sections.length > 0);
  const text = out.sections.map((s) => String(s.text || "")).join("\n");
  ok("注入进了 persona 段", text.includes("你是测试体"));
  const snap = path.join(home, "dsh-coco", "last-assembly.json");
  ok("主会话写了快照", fs.existsSync(snap));
}

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
