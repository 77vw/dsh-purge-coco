#!/usr/bin/env node
/**
 * 校验签名：
 *   1) SHA256SUMS.sig 的签名能否用 PUBLIC-KEY.txt 验通
 *   2) SHA256SUMS 里列的文件是否与磁盘一致
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sums = path.join(root, "dist", "SHA256SUMS");
const sigFile = path.join(root, "dist", "SHA256SUMS.sig");
const pubFile = path.join(root, "PUBLIC-KEY.txt");

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

ok("清单存在", fs.existsSync(sums));
ok("签名文件存在", fs.existsSync(sigFile));
ok("公钥存在", fs.existsSync(pubFile));
if (failed) process.exit(1);

const pub = crypto.createPublicKey(fs.readFileSync(pubFile, "utf8"));
const meta = JSON.parse(fs.readFileSync(sigFile, "utf8"));
const digest = crypto.createHash("sha256").update(fs.readFileSync(sums)).digest("hex");
ok("清单摘要与签名记录一致", digest === meta.sha256);
const valid = crypto.verify(null, Buffer.from(meta.sha256, "utf8"), pub, Buffer.from(meta.sig, "base64"));
ok("签名有效", valid);
ok("keyid 匹配", crypto.createHash("sha256").update(pub.export({ type: "spki", format: "pem" })).digest("hex").slice(0, 16) === meta.keyid);

let files = 0, bad = [];
for (const line of fs.readFileSync(sums, "utf8").trim().split("\n")) {
  const m = line.match(/^([a-f0-9]{64})\s+(.+)$/);
  if (!m) continue;
  files += 1;
  const fp = path.join(root, m[2]);
  try {
    const h = crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
    if (h !== m[1]) bad.push(m[2]);
  } catch { bad.push(m[2]); }
}
ok(`清单中 ${files} 个文件与磁盘一致`, bad.length === 0, bad.slice(0, 3).join(" "));

process.exit(failed ? 1 : 0);
