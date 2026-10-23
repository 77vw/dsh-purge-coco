/**
 * 统一日志（阶段 1.3）
 *
 * 之前 40 处 console.*，既不能按级别开关，也没法在设置页看。
 * 这里：
 *   · 写 JSONL 到 $DSH_HOME/dsh-coco/coco.log（1MB 翻滚）
 *   · 内存里留最近 200 条，供 /dsh-coco/status 显示
 *   · verbose 打开时才同时打到控制台
 */
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;
const RING = 200;

let sink = null;

function logPath(home) {
  return path.join(home, "dsh-coco", "coco.log");
}

function rotate(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(fp, fp + ".1");
  } catch { /* 不存在就算了 */ }
}

function makeLogger(level) {
  const ring = [];
  const write = (lvl, scope, msg, extra) => {
    const row = { at: Date.now(), lvl, scope, msg: String(msg).slice(0, 800) };
    if (extra !== undefined) {
      try { row.extra = JSON.parse(JSON.stringify(extra)); } catch { row.extra = String(extra); }
    }
    ring.push(row);
    if (ring.length > RING) ring.shift();
    if (sink) {
      try {
        rotate(sink);
        fs.mkdirSync(path.dirname(sink), { recursive: true });
        fs.appendFileSync(sink, JSON.stringify(row) + "\n", "utf8");
      } catch { /* 日志失败不能再抛 */ }
    }
    if (level === "debug" || (level === "info" && lvl !== "debug")) {
      const fn = lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log;
      try { fn(`[dsh-coco:${scope}] ${row.msg}`); } catch { /* ignore */ }
    }
  };
  return {
    error: (scope, msg, extra) => write("error", scope, msg, extra),
    warn: (scope, msg, extra) => write("warn", scope, msg, extra),
    info: (scope, msg, extra) => write("info", scope, msg, extra),
    debug: (scope, msg, extra) => write("debug", scope, msg, extra),
    recent: (n = 50) => ring.slice(-n),
  };
}

let logger = makeLogger("silent");

export function setLogHome(home) {
  if (!home) return logger;
  sink = logPath(home);
  return logger;
}

export function configure({ verbose = false, home = "" } = {}) {
  if (home) setLogHome(home);
  logger = makeLogger(verbose ? "debug" : "silent");
  logger.info("boot", "logger ready", { verbose, home });
  return logger;
}

export function getLogger() {
  return logger;
}
