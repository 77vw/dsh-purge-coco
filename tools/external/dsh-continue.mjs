// 会话中断自动继续（launchd ai.dsh.continue，每 60 秒）。
//
// 判定：会话末尾出现“本轮已中止 / 任务已停止 / 未完成的工具调用结果未知”这类标记，
//       且当前不在生成中（没有停止按钮）、输入框存在。
// 动作：用 CDP 往输入框发一句“继续”，发完回读页面确认真的动起来了。
//
// 防死循环（硬性）：
//   - 同一个中断现场最多发 2 次；第 3 次直接放弃并记日志
//   - 两次发送间隔 < 40 秒不重复发
//   - 1 小时内最多 6 次；30 分钟内“接上又立刻断”3 次 → 冷却 30 分钟
//
// 用法: node dsh-continue.mjs [--dry] [--force] [--text "..."]
// 退出码: 0 无需处理 / 10 已发送并确认恢复 / 11 已发送但未确认 / 20 已放弃（防循环）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { connect, classifyError } from "./dsh-cdp.mjs";
import { snapshot, sendMessage } from "./dsh-actions.mjs";

const TOOLS = path.join(os.homedir(), ".dsh", "tools");
const STATE = path.join(TOOLS, ".dsh-continue-state.json");
const LOG = path.join(TOOLS, "continue.log");
const LOCK = path.join(TOOLS, ".dsh-continue.lock");
const PAUSE = path.join(TOOLS, "PAUSED");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const FORCE = argv.includes("--force");
const ti = argv.indexOf("--text");
const TEXT = ti >= 0 && argv[ti + 1] ? argv[ti + 1] : "继续（上一轮被中断，请从中断处接着做，不要重头开始）";

const now = () => Math.floor(Date.now() / 1000);
const stamp = () => new Date().toLocaleString("zh-CN", { hour12: false });

function log(msg) {
  try {
    fs.appendFileSync(LOG, `${stamp()} ${msg}\n`);
    if (fs.statSync(LOG).size > 262144) fs.truncateSync(LOG, 0);
  } catch {}
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {}
}

if (fs.existsSync(PAUSE)) process.exit(0);

// 互斥锁（60 秒一轮，正常不会撞上；防止手动并发）
try {
  fs.mkdirSync(LOCK);
  fs.writeFileSync(path.join(LOCK, "pid"), String(process.pid));
} catch {
  try {
    const pid = Number(fs.readFileSync(path.join(LOCK, "pid"), "utf8"));
    process.kill(pid, 0);
    process.exit(0);
  } catch {
    try { fs.rmSync(LOCK, { recursive: true, force: true }); fs.mkdirSync(LOCK); } catch { process.exit(0); }
  }
}
const release = () => { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {} };
process.on("exit", release);
process.on("SIGTERM", () => { release(); process.exit(0); });

let c;
try {
  c = await connect();
} catch (e) {
  // 进程没起来/端口不通由 guard 处理，这里保持安静
  process.exit(0);
}

let snap;
try {
  snap = await snapshot(c);
} catch {
  process.exit(0);
}
c.close();

if (!snap || !snap.composer || snap.bodyLen < 200) process.exit(0);

const st = readState();
const t = now();

if (st.cooldownUntil && st.cooldownUntil > t && !FORCE) {
  process.exit(0); // 冷却中，安静等待
}

if (snap.busy) {
  // 在跑就别插话
  if (st.key) { st.key = null; st.sends = 0; writeState(st); }
  process.exit(0);
}

const interrupted =
  snap.errIdxFromEnd !== null &&
  snap.errIdxFromEnd <= 4 &&
  /本轮已中止|任务已停止|未完成的工具调用|interrupted/i.test(snap.errText || "");

if (!interrupted) {
  if (st.key) { st.key = null; st.sends = 0; writeState(st); }
  process.exit(0);
}

const key = crypto
  .createHash("sha1")
  .update(`${snap.flowCount}|${snap.errText}|${snap.tail}|${snap.title}`)
  .digest("hex")
  .slice(0, 16);

if (st.giveUpKey === key) process.exit(0);

const history = (st.history || []).filter((x) => x > t - 3600);
const recoveries = (st.recoveries || []).filter((x) => x > t - 1800);

if (!FORCE) {
  if (history.length >= 6) {
    st.cooldownUntil = t + 3600;
    writeState(st);
    log(`1 小时内已自动继续 ${history.length} 次，冷却 60 分钟`);
    process.exit(20);
  }
  if (recoveries.length >= 3) {
    st.cooldownUntil = t + 1800;
    writeState(st);
    log(`30 分钟内接上又断 ${recoveries.length} 次，冷却 30 分钟防循环`);
    process.exit(20);
  }
  if (st.lastAt && t - st.lastAt < 40) process.exit(0);
}

const sends = st.key === key ? (st.sends || 0) + 1 : 1;
if (sends > 2) {
  st.giveUpKey = key;
  st.sends = sends;
  st.key = key;
  writeState(st);
  log(`同一中断现场已连发 2 次无反应，停止自动继续 key=${key} tail="${(snap.tail || "").slice(0, 80)}"`);
  process.exit(20);
}

if (DRY) {
  log(`[dry] 检测到中断 key=${key} 第 ${sends} 次，将发送：${TEXT}`);
  console.log(JSON.stringify({ dry: true, key, sends, interrupted: true, errText: snap.errText }));
  process.exit(0);
}

let c2;
let result;
try {
  c2 = await connect();
  result = await sendMessage(c2, TEXT, { verifyMs: 5000 });
} catch (e) {
  log(`发送失败：${classifyError(e)}`);
  process.exit(0);
} finally {
  if (c2) c2.close();
}

if (!result?.ok) {
  log(`未发送（${result?.reason}）key=${key}`);
  process.exit(0);
}

const verified = !!result.verified;
const nst = {
  ...st,
  key,
  sends,
  lastAt: t,
  history: [...history, t],
  recoveries: verified ? [...recoveries, t] : recoveries,
  giveUpKey: st.giveUpKey === key ? null : st.giveUpKey,
};
writeState(nst);

log(
  `已自动继续 key=${key} 第 ${sends} 次 verified=${verified} ` +
  `err="${(snap.errText || "").slice(0, 60)}"`,
);

console.log(JSON.stringify({ sent: true, verified, key, sends }));
process.exit(verified ? 10 : 11);
