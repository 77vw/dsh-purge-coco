#!/usr/bin/env node
/**
 * 补丁可迁移性审计：把 86 条按「能否改由插件在运行时实现」分类。
 * 输出 .cache/patch-audit.md，供人工复核后逐批迁移。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(path.join(ROOT, "lib/core.js"));
const { ALL_PATCHES } = core;

const CONFIG = /^(preset-|agent-preset)/;
const POLICY = /^(escalation|user-approval|permission-presets|sandbox|fs-sandbox|fs-observation-policy)/;
const PACK = /^(desktop-shell|app-boot|pi-ai|llm-deepseek|web-app-lib|dev-context|conversation-client|session-log|deliverables-prompt|auto-review|hooks-|settings)/;
const BEHAVIOR = /.*/;

function firstFile(p) {
  return String((Array.isArray(p.file) ? p.file[0] : p.file) || "");
}

const rows = ALL_PATCHES.map((p) => {
  const f = firstFile(p);
  const cat = CONFIG.test(f) ? "配置" : POLICY.test(f) ? "策略" : PACK.test(f) ? "打包/网络" : BEHAVIOR.test(f) ? "行为" : "其他";
  return { id: p.id, name: p.name, file: f, layer: p.layer_en || p.layer || "", cat };
}).sort((a, b) => a.id - b.id);

const byCat = rows.reduce((a, r) => ((a[r.cat] = (a[r.cat] || 0) + 1), a), {});

const md = [];
md.push("# 补丁可迁移性审计", "");
md.push(`生成时间：${new Date().toISOString()}`, "");
md.push("| 类别 | 数量 | 迁移方式 |", "|---|---|---|");
md.push(`| 配置 | ${byCat["配置"] || 0} | 改成插件注入配置，不打宿主文件 |`);
md.push(`| 策略 | ${byCat["策略"] || 0} | 在 ctx 上重新注册策略服务 |`);
md.push(`| 行为 | ${byCat["行为"] || 0} | 部分可用 ctx 钩子拦，部分必须改源码 |`);
md.push(`| 打包/网络 | ${byCat["打包/网络"] || 0} | 只能文件层/进程层处理 |`);
md.push("", "## 明细", "", "| id | 名称 | 层 | 目标文件 | 类别 |", "|---|---|---|---|---|");
for (const r of rows) md.push(`| ${r.id} | ${r.name} | ${r.layer} | ${r.file} | ${r.cat} |`);

const out = path.join(ROOT, ".cache", "patch-audit.md");
fs.writeFileSync(out, md.join("\n") + "\n", "utf8");
console.log(JSON.stringify(byCat, null, 2));
console.log("报告:", path.relative(ROOT, out));

// 第一批候选：策略类（最小、最独立、最容易验证）
const batch1 = rows.filter((r) => r.cat === "策略");
console.log("\n第一批候选（策略类）:", batch1.map((r) => `#${r.id}`).join(" "));
