#!/usr/bin/env node
// dry-run：只读宿主 app.asar，统计 92 个补丁在目标版本上的命中率。
// 不写宿主、不重启、不改任何文件；解包缓存落在 .cache/ 下。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openAsar } from "./asar-read.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// apply 之后 app.asar 已让位；原归档在 .dsh-coco.bak 里，dry-run 应该读那一份
function resolveAsar() {
  if (process.env.DSH_ASAR) return process.env.DSH_ASAR;
  const base = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
  return fs.existsSync(base) ? base : `${base}.dsh-coco.bak`;
}
const ASAR = resolveAsar();
const CACHE = process.env.DRY_CACHE || path.join(ROOT, ".cache", "asar-dry");

/** 只取补丁可能命中的文件：@deepseek-ai 各包的 lib/*.js、lib/types/*.js、cordis.patch.yml、package.json、预设 yml */
function wanted(p) {
  if (/^dsh\/node_modules\/@deepseek-ai\/[^/]+\/(lib\/[^/]+\.js|lib\/types\/[^/]+\.js|cordis\.patch\.yml|package\.json)$/.test(p)) return true;
  if (/^dsh\/node_modules\/@earendil-works\/pi-ai\/dist\/api\/[^/]+\.js$/.test(p)) return true;
  // preset 目标在 dsh-web-app/presets/*.patch.yml，之前没解出来，导致 #24/#43/#80 被误判
  if (/^dsh\/node_modules\/@deepseek-ai\/[^/]+\/presets\/[^/]+\.patch\.yml$/.test(p)) return true;
  if (/^dsh\/lib\/[^/]+\.js$/.test(p)) return true;
  if (/^lib\/[^/]+\.(js|cjs|mjs)$/.test(p)) return true;
  if (/(^|\/)\.agent-presets\/.*\.ya?ml$/.test(p)) return true;
  if (/^dsh\/.*agent-presets.*\.ya?ml$/.test(p)) return true;
  return false;
}

function extract() {
  const a = openAsar(ASAR);
  let n = 0, bytes = 0;
  for (const f of a.list()) {
    if (!wanted(f.path)) continue;
    const buf = a.read(f.path);
    if (!buf) continue;
    const dest = path.join(CACHE, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    n += 1; bytes += buf.length;
  }
  a.close();
  console.log(`[extract] ${n} files, ${(bytes / 1048576).toFixed(1)} MB -> ${CACHE}`);
  return n;
}

const aiBase = path.join(CACHE, "dsh", "node_modules", "@deepseek-ai");
if (!fs.existsSync(aiBase)) extract();

const core = await import(path.join(ROOT, "lib", "core.js"));
const { ALL_PATCHES, targetFiles, applyReplacementsToText } = core;

const tempHome = process.env.DRY_DSH_HOME ? "" : fs.mkdtempSync(path.join(ROOT, ".cache", "home-"));
const dshHome = process.env.DRY_DSH_HOME || tempHome;
const targets = targetFiles(aiBase, dshHome);

// ── 0.2.1-rc.2 布局修正 ──────────────────────────────────────────
// 1) pi-ai 在 0.2.x 是外部包 @earendil-works/pi-ai，不在 @deepseek-ai 下
const piAiApi = path.join(CACHE, "dsh", "node_modules", "@earendil-works", "pi-ai", "dist", "api");
const piAiMap = {
  "pi-ai-completions": "openai-completions.js",
  "pi-ai-responses-shared": "openai-responses-shared.js",
  "pi-ai-anthropic-messages": "anthropic-messages.js",
};
for (const [k, f] of Object.entries(piAiMap)) {
  const fp = path.join(piAiApi, f);
  if (fs.existsSync(fp)) targets[k] = fp;
}
// 2) 桌面主进程在 asar 根的 lib/main.js
const shellMain = path.join(CACHE, "lib", "main.js");
if (fs.existsSync(shellMain)) targets["desktop-shell"] = shellMain;

// 生产环境是按 id 顺序、在同一份文本上依次打补丁；链式补丁（#45→#46、#82→#83）必须
// 看到前一条的输出，否则会被误判成 miss。这里用一份可变内存副本模拟同样顺序。
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
  let resolved = 0, hit = 0, already = 0, miss = 0, bytes = 0;
  const detail = [];
  for (const k of keys) {
    const v = targets[k];
    const paths = Array.isArray(v) ? v : (v ? [v] : []);
    if (!paths.length) { detail.push(`${k}: unresolved`); continue; }
    resolved += 1;
    for (const fp of paths) {
      const text = contentOf(fp);
      if (text === null) { detail.push(`${k}: unreadable`); continue; }
      bytes += text.length;
      const out = applyReplacementsToText(text, p, fp);
      if (out.changed) mem.set(fp, out.text);
      const marker = p.marker || (Array.isArray(p.markers) ? p.markers.some((m) => text.includes(m)) : false);
      if (out.changed) { hit += 1; }
      else if (marker) { already += 1; }
      else { miss += 1; detail.push(`${k}: miss`); }
    }
  }
  const verdict = hit > 0 ? "WOULD-APPLY" : (already > 0 && miss === 0 ? "already" : "MISS");
  rows.push({ id: p.id, name: p.name, layer: p.layer_en, keys: keys.join(","), resolved, hit, already, miss, bytes, verdict, detail });
}

const md = [];
const W = (s) => md.push(s);
const counts = rows.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
W(`# dry-run 命中率报告`);
W("");
W(`- 宿主: \`${ASAR}\``);
W(`- 目标: ${rows.length} 个补丁 / 逻辑文件 ${new Set(rows.flatMap((r) => r.keys.split(","))).size} 个`);
W(`- 结果: ${JSON.stringify(counts)}`);
W("");
W("| id | name | 层 | 目标文件 | 命中 | 已打过 | 未命中 | 判定 |");
W("|---|---|---|---|---|---|---|---|");
for (const r of rows.sort((a, b) => a.id - b.id)) {
  W(`| ${r.id} | ${r.name} | ${r.layer} | ${r.keys} | ${r.hit} | ${r.already} | ${r.miss} | ${r.verdict} |`);
}
const missRows = rows.filter((r) => r.verdict === "MISS");
W("");
W(`## 未命中 / 未解析 (${missRows.length})`);
for (const r of missRows) W(`- #${r.id} ${r.name} — ${r.detail.join("; ") || "无目标文件"}`);

const outFile = path.join(ROOT, ".cache", "dryrun-report.md");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, md.join("\n") + "\n");
console.log(`[report] ${outFile}`);
console.log(JSON.stringify(counts, null, 2));
if (tempHome) { try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ } }
