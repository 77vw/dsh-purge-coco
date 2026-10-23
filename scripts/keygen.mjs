#!/usr/bin/env node
/**
 * 生成发布签名密钥（Ed25519，纯 Node，不依赖 gpg / minisign）
 *
 *   node scripts/keygen.mjs [--force]
 *
 * 私钥：$DSH_HOME/coco-signing-key.pem（chmod 600，永不入库）
 * 公钥：dist/dsh-coco.pub + 仓库根 PUBLIC-KEY.txt（跟着发布走）
 *
 * 说明：这把钥匙是"项目钥匙"，由本机生成、只存在本机。谁拿到 PEM 谁就能冒充发布者，
 * 所以它不适合团队共享；要多人发布，各自生成、公钥都放进来（做多签校验）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const force = process.argv.includes("--force");
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const privPath = path.join(home, "coco-signing-key.pem");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pubPath = path.join(root, "PUBLIC-KEY.txt");

if (fs.existsSync(privPath) && !force) {
  const pub = crypto.createPublicKey(fs.readFileSync(privPath, "utf8")).export({ type: "spki", format: "pem" });
  console.log("已存在私钥，未覆盖：", privPath);
  console.log("（要重新生成加 --force，注意旧签名全部失效）");
  fs.writeFileSync(pubPath, pub, "utf8");
  process.exit(0);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
// 口令可选：有 COCO_SIGN_PASSPHRASE 就加密私钥（PKCS#8 + AES-256-CBC）
const passphrase = process.env.COCO_SIGN_PASSPHRASE || "";
const priv = passphrase
  ? privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase })
  : privateKey.export({ type: "pkcs8", format: "pem" });
const pub = publicKey.export({ type: "spki", format: "pem" });

fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(privPath, priv, { encoding: "utf8", mode: 0o600 });
fs.chmodSync(privPath, 0o600);
fs.writeFileSync(pubPath, pub, "utf8");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "dsh-coco.pub"), pub, "utf8");

const keyid = crypto.createHash("sha256").update(pub).digest("hex").slice(0, 16);
console.log("私钥:", privPath, "(600)");
console.log("公钥:", pubPath);
console.log("加密:", passphrase ? "是（AES-256-CBC，签名时需 COCO_SIGN_PASSPHRASE）" : "否");
console.log("keyid:", keyid);
console.log("指纹:", crypto.createHash("sha256").update(pub).digest("base64").slice(0, 43));
