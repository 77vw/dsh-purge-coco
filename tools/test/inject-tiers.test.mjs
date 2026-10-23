// 注入链档位：切块、装配、预算裁剪、自动选档
import fs from "node:fs";
import { composeInject, splitBlocks, estimateTokens, pickTier, TIERS } from "../../lib/inject/tiers.js";

let failed = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!cond) failed += 1; };

// 提示词优先读用户那份；没有就退回仓库里的出厂稿（CI 环境没有 ~/.dsh）
const userPrompt = (process.env.DSH_HOME || process.env.HOME + "/.dsh") + "/prompt-inject.md";
const repoPrompt = new URL("../../prompts/base.md", import.meta.url).pathname;
const promptPath = fs.existsSync(userPrompt) ? userPrompt : repoPrompt;
if (!fs.existsSync(promptPath)) { console.log("SKIP  inject-tiers：找不到提示词"); process.exit(0); }
const prompt = fs.readFileSync(promptPath, "utf8");
const blocks = splitBlocks(prompt);

ok("core 块非空（身份段）", blocks.core.trim().length > 200);
ok("routing 块存在", !!blocks.routing && blocks.routing.includes("Routing"));
ok("scoped 块存在", !!blocks.scoped && blocks.scoped.includes("Scoped Rules"));
ok("style 块存在", !!blocks.style && blocks.style.includes("Style"));

const full = composeInject(prompt, "full");
ok("full 保留全部块", full.blocks.length >= 5, `blocks=${full.blocks.map(b=>b.name).join(",")}`);
ok("full 文本包含 Scoped Rules", full.text.includes("Scoped Rules"));
const nonEmpty = (t) => t.split("\n").filter((l) => l.trim()).length;
ok("full 不丢任何非空行", nonEmpty(full.text) === nonEmpty(prompt), `${nonEmpty(full.text)} / ${nonEmpty(prompt)}`);

const lite = composeInject(prompt, "lite");
ok("lite 不含 Scoped Rules", !lite.text.includes("Scoped Rules"));
ok("lite 不含 Routing", !lite.text.includes("## Routing"));
ok("lite token 明显更少", lite.tokens < full.tokens, `${lite.tokens} < ${full.tokens}`);
ok("lite 保留身份段", lite.text.includes("小母狗"));

const std = composeInject(prompt, "standard");
ok("standard 含 Routing 不含 Scoped", std.text.includes("## Routing") && !std.text.includes("Scoped Rules"));

// 预算裁剪：budget 压到比全文小，必须丢掉 scoped/routing
const tight = composeInject(prompt, "full");
const saved = TIERS.full.budget;
TIERS.full.budget = Math.round(full.tokens * 0.6);
const trimmed = composeInject(prompt, "full");
TIERS.full.budget = saved;
ok("超预算会丢块", trimmed.dropped.length > 0, `dropped=${trimmed.dropped.join(",")}`);
ok("core 永不丢", trimmed.text.includes("小母狗"));
ok("裁剪后不超预算", trimmed.tokens <= Math.round(full.tokens * 0.6));

ok("自动选档 32k → lite", pickTier(32000) === "lite");
ok("自动选档 128k → standard", pickTier(128000) === "standard");
ok("自动选档 1M → full", pickTier(1000000) === "full");

const t = estimateTokens("中文中文中文abcd");
ok("token 估算合理", t >= 6 && t <= 10, `t=${t}`);

process.exit(failed ? 1 : 0);
