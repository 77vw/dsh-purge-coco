#!/usr/bin/env node
/**
 * 碎片巡检：任意会话的思考块里有多少「做。/好。/写。」这种祈使碎片。
 *
 * 用法：
 *   node tools/frag-audit.mjs               # 最近 8 个会话
 *   node tools/frag-audit.mjs 20            # 最近 20 个
 *   node tools/frag-audit.mjs --since 2026-10-28   # 只看这之后动过的
 *
 * 判读：
 *   · 碎片率 = 带 ≥5 个碎片的块 / 全部思考块。健康会话通常 0–5%。
 *   · 单块碎片 ≥50 记一次「失控」。新会话里这个数应当接近 0。
 *   · 若某会话失控数在涨，说明 idle-loop 没拦住或被绕过。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { isFillerLine } = await import(path.join(HERE, "..", "lib", "engine", "idle-loop.js"));

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]).getTime() : 0;
const limit = Number(args.find((a) => /^\d+$/.test(a))) || 8;

const root = path.join(os.homedir(), ".dsh", "sessions");
const files = [];
for (const ws of fs.readdirSync(root)) {
  const base = path.join(root, ws);
  if (!fs.statSync(base).isDirectory()) continue;
  for (const id of fs.readdirSync(base)) {
    const f = path.join(base, id, "session.v4.jsonl.zstd");
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    if (since && st.mtimeMs < since) continue;
    files.push({ id, f, size: st.size, mtime: st.mtimeMs });
  }
}
files.sort((a, b) => b.mtime - a.mtime);
const picked = files.slice(0, limit);

let zstdOk = true;
try { execFileSync("zstd", ["--version"], { stdio: "ignore" }); } catch { zstdOk = false; }
if (!zstdOk) { console.error("需要 zstd（brew install zstd）"); process.exit(1); }

console.log("会话                              块    带碎片   失控(≥50)  碎片率   单块最大  末次写入");
for (const s of picked) {
  let raw;
  try { raw = execFileSync("zstd", ["-dc", s.f], { maxBuffer: 1 << 30 }).toString("utf8"); } catch { continue; }
  let blocks = 0, withFrag = 0, runaway = 0, peak = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "assistant/message") continue;
    const content = e?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const r = content.filter((b) => b && b.type === "reasoning").map((b) => b.text || "").join("");
    if (!r) continue;
    blocks += 1;
    const frags = r.split("\n").filter((l) => isFillerLine(l)).length;
    if (frags >= 5) withFrag += 1;
    if (frags >= 50) runaway += 1;
    if (frags > peak) peak = frags;
  }
  if (!blocks) continue;
  const rate = ((withFrag / blocks) * 100).toFixed(1) + "%";
  const when = new Date(s.mtime).toISOString().slice(5, 16).replace("T", " ");
  console.log(
    `${s.id.slice(0, 32).padEnd(33)}${String(blocks).padStart(5)}${String(withFrag).padStart(8)}${String(runaway).padStart(10)}${rate.padStart(10)}${String(peak).padStart(10)}  ${when}`,
  );
}
