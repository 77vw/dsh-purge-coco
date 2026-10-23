// 签名原语：签、验、篡改检测、错公钥拒绝
import crypto from "node:crypto";
import { keyId, digestOf, signDigest, verifyDigest, publicFromPrivate } from "../../lib/engine/sign.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "pem" });
const pub = publicKey.export({ type: "spki", format: "pem" });

const payload = Buffer.from("abc  1.2.3\n", "utf8");
const digest = digestOf(payload);
const sig = signDigest(digest, priv);

ok("签名可验证", verifyDigest(digest, sig, pub));
ok("篡改摘要后验签失败", !verifyDigest(digestOf(Buffer.from("abc 1.2.4\n")), sig, pub));
ok("错公钥验签失败", (() => {
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  return !verifyDigest(digest, sig, other);
})());
ok("公钥可由私钥导出", publicFromPrivate(priv).includes("BEGIN PUBLIC KEY"));
ok("keyid 稳定", keyId(pub) === keyId(pub) && keyId(pub).length === 16);

process.exit(failed ? 1 : 0);
