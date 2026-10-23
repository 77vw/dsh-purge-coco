#!/usr/bin/env node
/**
 * 生成本地评测变体（不进仓库）
 *
 * 提示词不进仓库，所以 variants/*.md 也不进。跑评测前先生成：
 *   node tools/eval/gen-variants.mjs [--prompt ~/.dsh/prompt-inject.md]
 *
 * 产物：tools/eval/variants/{none,lite,standard,full}.md（已 gitignore）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };

const src = arg("prompt", path.join(os.homedir(), ".dsh", "prompt-inject.md"));
if (!fs.existsSync(src)) {
  console.error(`找不到提示词：${src}\n先用 --prompt 指定，或写到 ~/.dsh/prompt-inject.md`);
  process.exit(2);
}
const text = fs.readFileSync(src, "utf8");
const { composeInject } = await import(path.join(ROOT, "lib/inject/tiers.js"));

const outDir = path.join(HERE, "variants");
fs.mkdirSync(outDir, { recursive: true });
for (const tier of ["lite", "standard", "full"]) {
  const out = composeInject(text, tier);
  fs.writeFileSync(path.join(outDir, `${tier}.md`), out.text, "utf8");
  console.log(tier.padEnd(9), out.tokens, "tok");
}
fs.writeFileSync(path.join(outDir, "none.md"), "", "utf8");
console.log("none     0 tok");
console.log(`输出目录：${path.relative(ROOT, outDir)}`);
