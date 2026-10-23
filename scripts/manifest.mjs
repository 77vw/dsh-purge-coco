#!/usr/bin/env node
/**
 * 发布清单（第 8 阶段）
 *
 * 产出：
 *   dist/SHA256SUMS   相对路径 + 哈希，可用 `shasum -a 256 -c SHA256SUMS` 校验
 *   dist/manifest.json 结构化清单（版本、文件数、总字节、生成时间）
 *
 * 只收「会被安装的内容」：lib / client.js / bin / tools / docs / presets / skills /
 * cordis.patch.yml / package.json / README / NOTICE / PROVENANCE / LICENSE。
 * 排除 node_modules、.cache、备份文件。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist");
const INCLUDE_DIRS = ["lib", "bin", "tools", "scripts", "docs", "presets", "skills", "prompts", "locale"];
const INCLUDE_FILES = [
  "client.js", "package.json", "cordis.patch.yml", "README.md", "README.zh-CN.md",
  "README.coco.md", "NOTICE.md", "PROVENANCE.md", "LICENSE", "screenshots.json",
];
const SKIP = /(^|\/)(node_modules|\.cache|dist|\.github|out)(\/|$)/;
const SKIP_FILE = /(\.bak($|-)|\.dshcoco\.bak$|\.log$|\.DS_Store$)/;
// 人设与密封稿不进公开产物（见 docs/PRIVATE-PROMPT.md）
const SKIP_PRIVATE = /(^|\/)lib\/(default-prompt-inject[^/]*\.md|asset-table\.js)$/;

const files = [];
const walk = (rel) => {
  const abs = path.join(ROOT, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(path.join(rel, name));
    return;
  }
  const relPosix = rel.split(path.sep).join("/");
  if (SKIP.test(relPosix) || SKIP_FILE.test(relPosix) || SKIP_PRIVATE.test(relPosix)) return;
  files.push(relPosix);
};

for (const d of INCLUDE_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d);
for (const f of INCLUDE_FILES) if (fs.existsSync(path.join(ROOT, f))) files.push(f);

files.sort();
const lines = [];
let bytes = 0;
for (const rel of files) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  bytes += buf.length;
  lines.push(`${crypto.createHash("sha256").update(buf).digest("hex")}  ${rel}`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "SHA256SUMS"), lines.join("\n") + "\n", "utf8");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifest = {
  name: pkg.name,
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  files: files.length,
  bytes,
  sha256: crypto.createHash("sha256").update(lines.join("\n")).digest("hex"),
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`清单: ${files.length} 个文件 · ${(bytes / 1024).toFixed(1)} KB`);
console.log(`聚合 sha256: ${manifest.sha256}`);
console.log(`输出: dist/SHA256SUMS, dist/manifest.json`);
