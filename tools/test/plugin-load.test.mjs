// 冒烟：插件入口必须能被 Node 加载。
// node --check 只查语法，不解析 import —— 搬迁/改路径最容易留下死链，这条专门兜住。
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

try {
  const m = await import(path.join(ROOT, "lib/index.js"));
  ok("lib/index.js 可加载", true);
  ok("导出 apply", typeof m.apply === "function");
  ok("导出 name", typeof m.name === "string", m.name);
  ok("导出 inject", Array.isArray(m.inject));
} catch (e) {
  ok("lib/index.js 可加载", false, String(e && e.message));
}

// 客户端包也要能被 Node 解析（它只是被包在 ModuleLoader 里，语法必须合法）
try {
  const src = (await import("node:fs")).readFileSync(path.join(ROOT, "client.js"), "utf8");
  new Function(src);
  ok("client.js 语法可解析", true);
} catch (e) {
  ok("client.js 语法可解析", false, String(e && e.message));
}

process.exit(failed ? 1 : 0);
