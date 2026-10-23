/**
 * Ed25519 签名原语（第 8 阶段）
 *
 * 只做两件事：给定私钥签一段摘要、给定公钥验签。文件读写留在 scripts/ 里。
 * 之所以自己实现而不依赖 gpg：本机没有 gpg/minisign，而 Node 自带 Ed25519。
 */
import crypto from "node:crypto";

export function keyId(publicPem) {
  return crypto.createHash("sha256").update(String(publicPem)).digest("hex").slice(0, 16);
}

export function digestOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function signDigest(digestHex, privatePem, passphrase) {
  const key = crypto.createPrivateKey(passphrase ? { key: privatePem, passphrase } : privatePem);
  return crypto.sign(null, Buffer.from(String(digestHex), "utf8"), key).toString("base64");
}

export function verifyDigest(digestHex, sigBase64, publicPem) {
  try {
    const key = crypto.createPublicKey(publicPem);
    return crypto.verify(null, Buffer.from(String(digestHex), "utf8"), key, Buffer.from(String(sigBase64), "base64"));
  } catch {
    return false;
  }
}

export function publicFromPrivate(privatePem, passphrase) {
  const key = crypto.createPrivateKey(passphrase ? { key: privatePem, passphrase } : privatePem);
  return crypto.createPublicKey(key).export({ type: "spki", format: "pem" });
}
