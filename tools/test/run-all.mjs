#!/usr/bin/env node
/**
 * 一次性跑完 tools/test/*.test.mjs，汇总结果。
 * 任一子测试非零退出 → 整体失败。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

const results = [];
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], { encoding: "utf8" });
  const ms = Date.now() - started;
  results.push({ file: f, code: r.status ?? 1, ms, out: (r.stdout || "") + (r.stderr || "") });
}

let failed = 0;
for (const r of results) {
  const tag = r.code === 0 ? "PASS" : "FAIL";
  if (r.code !== 0) failed += 1;
  console.log(`${tag}  ${r.file.padEnd(30)} ${String(r.ms).padStart(6)}ms`);
  if (r.code !== 0) console.log(r.out.split("\n").slice(-12).map((l) => "      " + l).join("\n"));
}

console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
