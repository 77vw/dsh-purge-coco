#!/usr/bin/env node
/**
 * 签名发布清单（第 8 阶段）
 *
 *   node scripts/sign.mjs          # 用 Ed25519 私钥签 dist/SHA256SUMS
 *   node scripts/verify.mjs        # 校验
 *
 * 产物 dist/SHA256SUMS.sig（JSON）：
 *   { alg, keyid, at, sha256, sig }
 * 其中 sig = Ed25519(SHA256SUMS 的 sha256 十六进制串)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { keyId, digestOf, signDigest, publicFromPrivate } from "../lib/engine/sign.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const privPath = path.join(home, "coco-signing-key.pem");
const sums = path.join(root, "dist", "SHA256SUMS");
const out = path.join(root, "dist", "SHA256SUMS.sig");

if (!fs.existsSync(sums)) { console.error("先跑 npm run manifest 生成 dist/SHA256SUMS"); process.exit(2); }
if (!fs.existsSync(privPath)) {
  console.error("找不到私钥，先跑：node scripts/keygen.mjs");
  process.exit(2);
}

const privPem = fs.readFileSync(privPath, "utf8");
const encrypted = /ENCRYPTED/.test(privPem);
let passphrase;
if (encrypted) {
  passphrase = process.env.COCO_SIGN_PASSPHRASE || "";
  if (!passphrase) { console.error("私钥已加密，请设置 COCO_SIGN_PASSPHRASE"); process.exit(2); }
}
const keyid = keyId(publicFromPrivate(privPem, passphrase));
const digest = digestOf(fs.readFileSync(sums));
const sig = signDigest(digest, privPem, passphrase);

const payload = { alg: "ed25519", keyid, at: new Date().toISOString(), sha256: digest, sig };
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log("已签名:", path.relative(root, out));
console.log("keyid:", keyid, "· sha256:", digest.slice(0, 16) + "…");
