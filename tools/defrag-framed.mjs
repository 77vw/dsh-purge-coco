#!/usr/bin/env node
/**
 * 会话净化（多帧版）。和 defrag-session.py 做的事一样，但输出保持宿主的帧结构。
 *
 * 为什么必须分帧：
 *   宿主的会话读取器是 scanZstdFrames() + decode(source, frames) —— 它按 zstd
 *   frame 逐帧解码，元数据读者只读前几帧就把 title / stats 拿出来。
 *   用 `zstd -19` 压出来的是【一帧 80 MB】，读 header 等于解压整条会话，
 *   于是这条会话在列表里被跳过 —— 文件字节层面全合法，但宿主看不见它。
 *   原文件是 11,978 帧（每帧约 2 行），这里按 ~600 KB 一片重建。
 *
 * 用法：
 *   node tools/defrag-framed.mjs <session.v4.jsonl.zstd> --dry-run
 *   node tools/defrag-framed.mjs <session.v4.jsonl.zstd> --apply
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { isFillerLine } = await import(path.join(HERE, "..", "lib", "engine", "idle-loop.js"));

const FRAME_TARGET = 600 * 1024; // 每帧解压后约 600 KB，远小于宿主的 1 MB 解码缓冲
const MAGIC = 0xfd2fb528;

function scanFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== MAGIC) return { frames, ok: false };
    const start = offset;
    offset += 4;
    const desc = buf.readUInt8(offset);
    offset += 1;
    const csf = desc >>> 6;
    const single = (desc & 32) !== 0;
    const checksum = (desc & 4) !== 0;
    const df = desc & 3;
    offset += (single ? 0 : 1) + (df === 3 ? 4 : df) + (csf === 0 ? (single ? 1 : 0) : 1 << csf);
    for (;;) {
      if (buf.length - offset < 3) return { frames, ok: false };
      const bh = buf.readUIntLE(offset, 3);
      offset += 3;
      const last = (bh & 1) !== 0;
      const bt = (bh >>> 1) & 3;
      offset += bt === 1 ? 1 : bh >>> 3;
      if (last) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return { frames, ok: offset === buf.length };
}

const clean = (text) => {
  if (!text) return { text, dropped: 0 };
  let dropped = 0;
  const kept = [];
  for (const line of text.split("\n")) {
    if (isFillerLine(line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n"), dropped };
};

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("usage: node tools/defrag-framed.mjs <session.v4.jsonl.zstd> [--apply]");
  process.exit(2);
}
const apply = process.argv.includes("--apply");

const srcBuf = fs.readFileSync(file);
const before = scanFrames(srcBuf);
// Node 的公开 API 只解第一帧，必须按扫描出的帧边界逐帧解压再拼
const raw = Buffer.concat(before.frames.map((f) => zlib.zstdDecompressSync(srcBuf.subarray(f.start, f.end))));
console.log(`file            ${file}`);
console.log(`bytes           ${fs.statSync(file).size.toLocaleString()}`);
console.log(`frames in       ${before.frames.length.toLocaleString()}  (scan ok: ${before.ok})`);

const text = raw.toString("utf8");
const lines = text.split("\n").filter((l) => l.length > 0);
console.log(`lines           ${lines.length.toLocaleString()}`);

let blocks = 0;
let changed = 0;
let droppedTotal = 0;
let charsBefore = 0;
let charsAfter = 0;

const outLines = lines.map((line) => {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return line;
  }
  const content = e?.data?.message?.content;
  if (e?.type === "assistant/message" && Array.isArray(content)) {
    let touched = false;
    for (const blk of content) {
      if (!blk || blk.type !== "reasoning") continue;
      blocks += 1;
      const beforeText = blk.text || "";
      const { text: afterText, dropped } = clean(beforeText);
      charsBefore += beforeText.length;
      charsAfter += afterText.length;
      if (dropped) {
        blk.text = afterText;
        droppedTotal += dropped;
        touched = true;
      }
    }
    if (touched) changed += 1;
  }
  return JSON.stringify(e);
});

console.log(`reasoning blocks ${blocks.toLocaleString()}  (changed ${changed.toLocaleString()})`);
console.log(`filler lines cut ${droppedTotal.toLocaleString()}`);
if (charsBefore) console.log(`reasoning chars  ${charsBefore.toLocaleString()} -> ${charsAfter.toLocaleString()}  (-${((1 - charsAfter / charsBefore) * 100).toFixed(1)}%)`);

// 分帧：按累积字节切，切点永远落在行边界
const frames = [];
let bucket = [];
let size = 0;
for (const line of outLines) {
  bucket.push(line);
  size += Buffer.byteLength(line) + 1;
  if (size >= FRAME_TARGET) {
    frames.push(zlib.zstdCompressSync(Buffer.from(bucket.join("\n") + "\n")));
    bucket = [];
    size = 0;
  }
}
if (bucket.length) frames.push(zlib.zstdCompressSync(Buffer.from(bucket.join("\n") + "\n")));

const out = Buffer.concat(frames);
const after = scanFrames(out);
const decoded = Buffer.concat(after.frames.map((f) => zlib.zstdDecompressSync(out.subarray(f.start, f.end))));
const decodedLines = decoded.toString("utf8").split("\n").filter((l) => l.length > 0);

console.log(`frames out      ${frames.length.toLocaleString()}  (scan ok: ${after.ok})`);
console.log(`bytes out       ${out.length.toLocaleString()}`);
console.log(`lines out       ${decodedLines.length.toLocaleString()}  (expect ${lines.length.toLocaleString()})`);
console.log(`max frame       ${Math.max(...after.frames.map((f) => f.end - f.start)).toLocaleString()} B compressed`);

const ok = after.ok && decodedLines.length === lines.length && after.frames.length > 10;
console.log(`\nverdict         ${ok ? "PASS" : "FAIL"}`);

if (!apply) {
  fs.writeFileSync("/tmp/defrag-framed.out.zst", out);
  console.log("已写 /tmp/defrag-framed.out.zst（未替换）。加 --apply 替换。");
  process.exit(ok ? 0 : 1);
}
if (!ok) {
  console.error("校验未通过，不替换");
  process.exit(1);
}

const bak = file + `.bak-framed-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
fs.copyFileSync(file, bak);
fs.writeFileSync(file + ".tmp", out);
fs.renameSync(file + ".tmp", file);
console.log(`\n已替换。备份：${bak}`);
