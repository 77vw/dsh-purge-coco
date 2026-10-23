#!/usr/bin/env node
/**
 * 发布前隐私扫描：仓库里不许出现本机痕迹。
 *
 *   node scripts/privacy-scan.mjs        # 报告
 *   node scripts/privacy-scan.mjs --strict  # 命中即退出 1
 *
 * 检查项：绝对路径、用户名、主机名、邮箱、API key、会话 id、私钥块。
 * 允许的例外写在 ALLOW 里（例如第三方署名邮箱、示例地址）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SKIP_DIRS = new Set(["node_modules", ".cache", "dist", ".git", "out", ".github"]);
const SKIP_FILE = /(\.bak($|-)|\.dshcoco\.bak$|\.log$|\.DS_Store$|\.pem$)/;
const SKIP_SELF = new Set(["scripts/privacy-scan.mjs"]);

const RULES = [
  { name: "绝对路径", re: /\/Users\/[A-Za-z0-9._-]+/g },
  { name: "Windows 用户目录", re: /C:\\\\Users\\\\[A-Za-z0-9._-]+/g },
  { name: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g },
  { name: "API key", re: /sk-[A-Za-z0-9]{16,}/g },
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "会话 id", re: /session-[0-9a-f]{8}-[0-9a-f]{4}/g },
  { name: "设备/主机名", re: /\b(MacBook|iMac|Mac mini|Bowen|bowen)[-A-Za-z0-9]*\b/g },
];

// 允许出现的第三方信息（署名与示例）
const ALLOW = [
  "a2269198325@163.com",        // 上游作者公开联系邮箱，LICENSE/NOTICE 归属用
  "alice@my-vps.example.com",   // 文档里的示例
  "yu@example.com",
];

const hits = [];
const walk = (rel) => {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(abs))) return;
    for (const f of fs.readdirSync(abs)) walk(path.join(rel, f));
    return;
  }
  const relPosix = rel.split(path.sep).join("/");
  if (SKIP_FILE.test(relPosix) || SKIP_SELF.has(relPosix)) return;
  if (!/\.(js|mjs|json|md|yml|yaml|txt|html|css)$/.test(relPosix)) return;
  const text = fs.readFileSync(abs, "utf8");
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const value = m[0];
      if (ALLOW.some((a) => value.includes(a))) continue;
      const line = text.slice(0, m.index).split("\n").length;
      hits.push({ file: relPosix, line, rule: rule.name, value });
    }
  }
};
for (const f of fs.readdirSync(ROOT)) walk(f);

if (hits.length === 0) {
  console.log("PASS  未发现本机痕迹");
} else {
  console.log(`发现 ${hits.length} 处：`);
  for (const h of hits.slice(0, 40)) console.log(`  ${h.file}:${h.line}  [${h.rule}] ${h.value}`);
}
process.exit(process.argv.includes("--strict") && hits.length ? 1 : 0);
