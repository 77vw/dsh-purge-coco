// 错误码与日志（阶段 1）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CocoError, toWire, codeFromMessage, CODES } from "../../lib/engine/errors.js";
import { configure, getLogger } from "../../lib/engine/log.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const e = new CocoError("E102", "#32 web-app-lib");
ok("错误消息带码", e.message.startsWith("E102"));
ok("toJSON 结构", e.toJSON().code === "E102" && !!e.toJSON().message);
ok("普通异常能被归类", toWire(new Error("ENOENT: no such file")).code === "E101");
ok("timeout 归类", toWire(new Error("request timeout")).code === "E503");
ok("未知异常走兜底", toWire(new Error("???"), "E103").code === "E103");
ok("codeFromMessage 认 toolFilter", codeFromMessage("toolFilter is no longer supported") === "E102");
ok("码表非空", Object.keys(CODES).length >= 15);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "coco-log-"));
const logger = configure({ verbose: false, home });
logger.info("t", "hello");
logger.error("t", "boom", { file: "x.js" });
const ring = logger.recent(5);
ok("内存环形缓冲记录", ring.length >= 2);
const fp = path.join(home, "dsh-coco", "coco.log");
ok("落盘存在", fs.existsSync(fp));
const lines = fs.readFileSync(fp, "utf8").trim().split("\n");
ok("JSONL 可解析", lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
ok("getLogger 返回同一实例", getLogger() === logger);
fs.rmSync(home, { recursive: true, force: true });

process.exit(failed ? 1 : 0);
