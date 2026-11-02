// 自动点掉 DSH 原生弹框（崩溃恢复框 / 退出确认框）。
// 用法:
//   node dsh-dismiss.mjs --probe                 探测当前环境能否做 AX 自动化（3 秒内返回）
//   node dsh-dismiss.mjs --watch 45              盯 45 秒，见到弹框就按
//   node dsh-dismiss.mjs --watch 10 --dry        只看不按
//   node dsh-dismiss.mjs --process osascript --watch 5   （测试用）
// 退出码: 0 已按 / 1 无弹框 / 2 AX 不可用 / 3 osascript 超时
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const jxa = path.join(here, "dsh-dismiss.jxa.js");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const probe = argv.includes("--probe");
const dry = argv.includes("--dry");
const proc = arg("--process", "DeepSeek Harness");
const watch = probe ? 0 : Number(arg("--watch", 0));
const hardTimeout = probe ? 3000 : Math.max(8000, watch * 1000 + 8000);

function runJxa(secs) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", jxa, proc, String(secs), dry ? "dry" : ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, hardTimeout);
    const bail = () => { try { child.kill("SIGKILL"); } catch {} process.exit(0); };
    process.once("SIGTERM", bail);
    process.once("SIGINT", bail);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: String(e) });
    });
  });
}

const r = await runJxa(watch);

if (r.code === 137 || (!r.out && r.code !== 0)) {
  console.log(JSON.stringify({ ok: false, reason: "AX_UNAVAILABLE", error: r.err || "timeout/killed" }));
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(r.out);
} catch {
  console.log(JSON.stringify({ ok: false, reason: "BAD_OUTPUT", out: r.out, error: r.err }));
  process.exit(2);
}

if (probe) {
  if (!parsed.processFound && parsed.errors && parsed.errors.length) {
    console.log(JSON.stringify({ ok: false, reason: "AX_UNAVAILABLE", detail: parsed }));
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, probe: true, processFound: !!parsed.processFound }));
  process.exit(0);
}

if (parsed.pressed && parsed.pressed.length) {
  console.log(JSON.stringify({ ok: true, pressed: parsed.pressed, dialogs: parsed.dialogs, seen: parsed.seen.slice(-10) }));
  process.exit(0);
}
if (parsed.wouldPress) {
  console.log(JSON.stringify({ ok: true, dry: true, wouldPress: parsed.wouldPress, seen: parsed.seen.slice(-10) }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: true, pressed: [], dialogs: parsed.dialogs, seen: parsed.seen.slice(-10) }));
process.exit(1);
