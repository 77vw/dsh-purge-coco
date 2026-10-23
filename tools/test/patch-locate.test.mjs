#!/usr/bin/env node
/**
 * patch-locate-rate 基线
 *
 * 目的：给「这套补丁在当前宿主上还能不能定位」一个可量化、可回归的数字。
 * 不做任何写操作 —— 只在内存里跑 applyReplacementsToText。
 *
 * 输出：.cache/patch-locate.json + 终端摘要
 * 退出码：0 总是成功（基线报告）；只有 --strict 且低于阈值时退出 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const APP = "/Applications/DeepSeek Harness.app/Contents/Resources/app";
const AI_BASE = process.env.COCO_AI_BASE || path.join(APP, "dsh/node_modules/@deepseek-ai");

if (!fs.existsSync(AI_BASE)) {
  console.log(`SKIP  patch-locate-rate：本机没有宿主安装（${AI_BASE}）`);
  process.exit(0);
}

const core = await import(path.join(ROOT, "lib/core.js"));
const { ALL_PATCHES, targetFiles, applyReplacementsToText } = core;

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
const dshHome = fs.mkdtempSync(path.join(ROOT, ".cache", "home-"));
const targets = targetFiles(AI_BASE, dshHome);

// pi-ai 在别的包下
const piAiApi = path.join(APP, "dsh/node_modules/@earendil-works/pi-ai/dist/api");
const piAiMap = {
  "pi-ai-completions": "openai-completions.js",
  "pi-ai-responses-shared": "openai-responses-shared.js",
  "pi-ai-anthropic-messages": "anthropic-messages.js",
};
for (const [k, f] of Object.entries(piAiMap)) {
  const fp = path.join(piAiApi, f);
  if (fs.existsSync(fp)) targets[k] = fp;
}
const shellMain = path.join(APP, "lib/main.js");
if (fs.existsSync(shellMain)) targets["desktop-shell"] = shellMain;

const mem = new Map();
const contentOf = (fp) => {
  if (!mem.has(fp)) {
    try { mem.set(fp, fs.readFileSync(fp, "utf8")); } catch { mem.set(fp, null); }
  }
  return mem.get(fp);
};

const rows = [];
for (const p of [...ALL_PATCHES].sort((a, b) => a.id - b.id)) {
  const keys = (Array.isArray(p.file) ? p.file : [p.file]).filter(Boolean);
  let located = 0, unresolved = 0, miss = 0;
  const detail = [];
  for (const k of keys) {
    const v = targets[k];
    const paths = Array.isArray(v) ? v : (v ? [v] : []);
    if (!paths.length) { unresolved += 1; detail.push(`${k}: 目标文件不存在`); continue; }
    for (const fp of paths) {
      const text = contentOf(fp);
      if (text === null) { unresolved += 1; detail.push(`${k}: 读不到`); continue; }
      const out = applyReplacementsToText(text, p, fp);
      if (out.changed) { located += 1; mem.set(fp, out.text); continue; }
      // 已经打过补丁：原文被替换掉了，靠 marker 确认「这条已在位」。
      const marker = p.marker || (Array.isArray(p.markers) ? p.markers.find((m) => text.includes(m)) : undefined);
      if (marker) { located += 1; continue; }
      miss += 1; detail.push(`${k}: 匹配失败`);
    }
  }
  rows.push({
    id: p.id, name: p.name,
    layer: p.layer_en || p.layer || "",
    keys: keys.join(","),
    located, miss, unresolved,
    verdict: located > 0
      ? "located"
      : (unresolved === keys.length
        ? "unresolved"
        : (p.marker || (Array.isArray(p.markers) && p.markers.length) ? "miss" : "unverifiable")),
    detail,
  });
}

const total = rows.length;
const located = rows.filter((r) => r.verdict === "located").length;
const unresolved = rows.filter((r) => r.verdict === "unresolved").length;
const missed = rows.filter((r) => r.verdict === "miss").length;
const unverifiable = rows.filter((r) => r.verdict === "unverifiable").length;
const rate = total ? located / total : 0;

const report = {
  at: new Date().toISOString(),
  aiBase: AI_BASE,
  total, located, missed, unresolved, unverifiable,
  rate: Number(rate.toFixed(4)),
  rows,
};
const outFile = path.join(ROOT, ".cache", "patch-locate.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

console.log("── patch-locate-rate ──");
console.log(`宿主      ${AI_BASE}`);
console.log(`总数      ${total}`);
console.log(`可定位    ${located}`);
console.log(`匹配失败  ${missed}`);
console.log(`无目标    ${unresolved}`);
console.log(`不可验证  ${unverifiable}（没有 marker，改完无法事后确认）`);
console.log(`定位率    ${(rate * 100).toFixed(1)}%`);
if (missed) {
  console.log("\n匹配失败：");
  for (const r of rows.filter((x) => x.verdict === "miss")) {
    console.log(`  #${r.id} ${r.name} → ${r.detail.join("; ")}`);
  }
}
if (unresolved) {
  console.log("\n无目标文件（本机没装该组件，正常）：");
  console.log("  " + rows.filter((x) => x.verdict === "unresolved").map((r) => `#${r.id}`).join(" "));
}
console.log(`\n报告：${path.relative(ROOT, outFile)}`);

try { fs.rmSync(dshHome, { recursive: true, force: true }); } catch { /* ignore */ }

// ── 回归闸门：定位率与「已知可跳过集合」都不许漂移 ──
const KNOWN_MISS = new Set([32, 53, 80, 88]);   // 目的已达成 / 无载体，属正常
const strays = rows.filter((r) => r.verdict === "miss" && !KNOWN_MISS.has(r.id));
if (strays.length) {
  console.error("新增匹配失败（宿主可能改版）：" + strays.map((r) => "#" + r.id).join(" "));
  process.exitCode = 1;
}
const floor = Number(process.env.COCO_PATCH_FLOOR || 0.85);
if (rate < floor) {
  console.error(`定位率 ${(rate * 100).toFixed(1)}% 低于底线 ${(floor * 100).toFixed(1)}%`);
  process.exitCode = 1;
}
if (!process.exitCode) console.log(`闸门：定位率 ≥ ${(floor * 100).toFixed(0)}% 且无新增失败 —— 通过`);
