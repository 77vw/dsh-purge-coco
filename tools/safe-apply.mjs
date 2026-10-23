#!/usr/bin/env node
/**
 * DSH-coco 安全 Apply 内核（可逆 asar 换目录）
 *
 * 只做一件事：把 app.asar 安全地「改名让位 → 解包成 app/」，并且任何一步失败都能原地还原。
 * 不在这里打补丁；补丁由插件自己的 core.js 在解包目录上完成。
 *
 * 核心保证：
 *   1. 先落 staging 目录，验证通过才提交，绝不边解边覆盖；
 *   2. 提交只有两步 rename，中间窗口 < 1 次 syscall；
 *   3. 全程写 manifest（原 asar 的 sha256），随时可 verify / recover；
 *   4. recover 不需要宿主能启动——纯文件操作，终端里就能跑。
 *
 * 用法：
 *   node tools/safe-apply.mjs status   --app "/Applications/DeepSeek Harness.app"
 *   node tools/safe-apply.mjs preflight --app ...
 *   node tools/safe-apply.mjs apply    --app ...
 *   node tools/safe-apply.mjs verify   --app ...
 *   node tools/safe-apply.mjs recover  --app ...
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { openAsar } from "./asar-read.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const argOf = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const APP = path.resolve(argOf("app", "/Applications/DeepSeek Harness.app"));
const RES = path.join(APP, "Contents", "Resources");
const ASAR = path.join(RES, "app.asar");
const BAK = path.join(RES, "app.asar.dsh-coco.bak");
const APPDIR = path.join(RES, "app");
const STATE = path.join(RES, ".dsh-coco");
const MANIFEST = path.join(STATE, "manifest.json");
const STAGING = path.join(STATE, "staging");

const log = (...a) => console.log(...a);
const fail = (msg) => { throw new Error(msg); };

function sha256File(fp) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(fp, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

function dirStats(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return null; }
}
function writeManifest(m) {
  fs.mkdirSync(STATE, { recursive: true });
  const tmp = `${MANIFEST}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
  fs.renameSync(tmp, MANIFEST);
}

function appRunning() {
  // macOS 的 pgrep -f 对长 pattern 不可靠，直接读 ps 再在 JS 里匹配
  try {
    const out = execSync("ps -axo command", { encoding: "utf8", maxBuffer: 8 << 20 });
    const needle = path.join(APP, "Contents", "MacOS");
    return out.split("\n").some((line) => line.includes(needle));
  } catch { return false; }
}


/* ------------------------------------------------------------ 签名 */

function codesignOk(app) {
  try {
    execSync(`codesign --verify --deep --strict ${JSON.stringify(app)} 2>&1`, { stdio: "pipe" });
    return true;
  } catch { return false; }
}

function signingSummary(app) {
  let out = "";
  try { out = execSync(`codesign -dvv ${JSON.stringify(app)} 2>&1`, { encoding: "utf8" }); } catch (e) { out = String(e.stdout || ""); }
  const authority = (out.match(/Authority=([^\n]+)/) || [])[1] || "（无）";
  const flags = (out.match(/flags=([^\s]+)/) || [])[1] || "";
  const team = (out.match(/TeamIdentifier=([^\n]+)/) || [])[1] || "";
  return { authority, flags, team, text: out.trim() };
}

function quarantineOf(app) {
  try { return execSync(`xattr -p com.apple.quarantine ${JSON.stringify(app)} 2>/dev/null`, { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function resign(app) {
  execSync(`codesign --force --deep --sign - ${JSON.stringify(app)} 2>&1`, { stdio: "pipe" });
  try { execSync(`xattr -dr com.apple.quarantine ${JSON.stringify(app)} 2>&1`, { stdio: "pipe" }); } catch { /* 没有就算了 */ }
}

/* ---------------------------------------------------------------- 命令 */

function status() {
  const m = readManifest();
  log(`app      ${APP}`);
  log(`asar     ${fs.existsSync(ASAR) ? `${(fs.statSync(ASAR).size / 1048576).toFixed(1)} MB` : "缺失"}`);
  log(`bak      ${fs.existsSync(BAK) ? `${(fs.statSync(BAK).size / 1048576).toFixed(1)} MB` : "无"}`);
  log(`app/     ${fs.existsSync(APPDIR) ? `${dirStats(APPDIR).files} files` : "无"}`);
  log(`manifest ${m ? `有（${m.createdAt}）` : "无"}`);
  log(`状态     ${describe()}`);
  log(`签名     ${codesignOk(APP) ? "有效" : "已失效"}  ${signingSummary(APP).authority}`);
  const q = quarantineOf(APP);
  log(`隔离标记 ${q ? "有（" + q.slice(0, 24) + "…）" : "无"}`);
}

function describe() {
  const a = fs.existsSync(ASAR), d = fs.existsSync(APPDIR), b = fs.existsSync(BAK);
  if (a && !d && !b) return "干净（未 apply）";
  if (!a && d && b) return "已 apply（asar 已让位，app/ 生效）";
  if (!a && d && !b) return "⚠️ 异常：asar 不见了，也没有备份";
  if (a && d) return "⚠️ 异常：asar 和 app/ 同时存在（Electron 会优先用 asar）";
  if (!a && !d) return "⚠️ 异常：两者都没有";
  return "未知";
}

function preflight() {
  const problems = [];
  if (!fs.existsSync(APP)) problems.push(`app 不存在: ${APP}`);
  if (!fs.existsSync(ASAR)) problems.push("app.asar 不存在");
  if (fs.existsSync(APPDIR)) problems.push("Contents/Resources/app 已存在（已 apply 或有旧解包）");
  if (fs.existsSync(BAK)) problems.push("已存在 .bak（上次没收拾干净）");
  try { fs.accessSync(RES, fs.constants.W_OK); } catch { problems.push("Resources 目录不可写"); }
  const st = fs.existsSync(ASAR) ? fs.statSync(ASAR) : null;
  if (st) {
    const free = (() => { try { return fs.statfsSync(RES).bavail * fs.statfsSync(RES).bsize; } catch { return Infinity; } })();
    const need = st.size * 2.2;
    if (free < need) problems.push(`磁盘不足：需要约 ${(need / 1073741824).toFixed(1)} GB，可用 ${(free / 1073741824).toFixed(1)} GB`);
  }
  if (appRunning()) problems.push("DSH 正在运行，先完全退出");
  if (fs.existsSync(APP)) {
    const info = signingSummary(APP);
    log(`签名信息 ${info.authority}${info.team ? ` / ${info.team}` : ""}`);
    if (quarantineOf(APP)) log("隔离标记 有 —— apply 后若无法启动，可加 --resign 或先 xattr -dr");
  }
  if (problems.length) {
    log("preflight 失败：");
    for (const p of problems) log("  ✗", p);
    process.exitCode = 1;
    return false;
  }
  log("preflight 通过");
  return true;
}

function extractTo(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const a = openAsar(ASAR);
  let n = 0;
  for (const f of a.list()) {
    const buf = a.read(f.path);
    if (!buf) continue;
    const out = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    n += 1;
  }
  a.close();
  return n;
}

function apply() {
  if (!preflight()) return;
  const before = sha256File(ASAR);
  const size = fs.statSync(ASAR).size;
  log(`原 asar sha256 ${before.slice(0, 16)}…  ${(size / 1048576).toFixed(1)} MB`);

  log("解包到 staging…");
  const n = extractTo(STAGING);
  const stats = dirStats(STAGING);
  log(`  ${n} 个条目 / ${stats.files} 个文件 / ${(stats.bytes / 1048576).toFixed(1)} MB`);
  if (n === 0) fail("解包结果为空，中止");

  writeManifest({
    tool: "dsh-coco",
    format: 1,
    app: APP,
    asar: { path: ASAR, sha256: before, size, mtimeMs: Math.round(fs.statSync(ASAR).mtimeMs) },
    extracted: { entries: n, files: stats.files, bytes: stats.bytes },
    createdAt: new Date().toISOString(),
  });

  // 提交：两次 rename，中间窗口最小
  try {
    fs.renameSync(ASAR, BAK);
  } catch (e) {
    fail(`asar 让位失败，未做任何改动: ${e.message}`);
  }
  try {
    fs.renameSync(STAGING, APPDIR);
  } catch (e) {
    fs.renameSync(BAK, ASAR);              // 立刻还原
    fail(`staging 提交失败，已还原 asar: ${e.message}`);
  }
  log("提交完成");
  if (argv.includes("--resign")) {
    log("ad-hoc 重签（会覆盖官方签名，不可逆）…");
    try { resign(APP); log("  已重签并移除隔离标记"); }
    catch (e) { log(`  重签失败（不影响还原）: ${e.message}`); }
  } else {
    log("签名现已失效（符合预期）。重启失败时运行: dsh-coco --recover");
  }
  verify();
}

function verify() {
  const m = readManifest();
  if (!m) {
    log("没有 manifest，只能看状态：", describe());
    process.exitCode = fs.existsSync(APPDIR) ? 1 : 0;
    return;
  }
  const now = dirStats(APPDIR);
  const okFiles = now.files === m.extracted.files;
  log(`app/ 文件数 ${now.files} / 期望 ${m.extracted.files}  ${okFiles ? "✓" : "✗"}`);
  if (fs.existsSync(BAK)) {
    const sha = sha256File(BAK);
    log(`备份 asar sha256 ${sha === m.asar.sha256 ? "✓ 与记录一致" : "✗ 不一致"}`);
  } else if (fs.existsSync(ASAR)) {
    const sha = sha256File(ASAR);
    log(`asar 已归位 ${sha === m.asar.sha256 ? "✓ 与记录一致" : "✗ 不一致"}`);
  } else {
    log("✗ asar 和 bak 都不存在");
  }
  log(`签名状态 ${codesignOk(APP) ? "✓ 有效" : "✗ 已失效（ad-hoc 或未重签）"}`);
  if (!okFiles) process.exitCode = 1;
}

function recover() {
  const m = readManifest();
  log("开始还原…");
  if (fs.existsSync(APPDIR)) {
    fs.rmSync(APPDIR, { recursive: true, force: true });
    log("  删除 app/");
  }
  if (fs.existsSync(BAK)) {
    fs.renameSync(BAK, ASAR);
    log("  asar 归位");
  }
  if (m) {
    const sha = sha256File(ASAR);
    log(sha === m.asar.sha256 ? "  ✓ sha256 与记录一致" : "  ✗ sha256 不一致（可能不是同一份）");
  }
  fs.rmSync(STATE, { recursive: true, force: true });
  log(`签名     ${codesignOk(APP) ? "✓ 已恢复有效（官方签名完好）" : "仍无效（曾 --resign，官方签名已被覆盖）"}`);
  log("完成，状态：", describe());
}

const cmds = { status, preflight, apply, verify, recover };
try {
  (cmds[cmd] || status)();
} catch (e) {
  log("错误：", e.message);
  process.exitCode = 1;
}
