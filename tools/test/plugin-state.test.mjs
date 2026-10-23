// 插件侧（lib/asar-manifest.js）与 CLI 侧（tools/safe-apply.mjs）必须对同一份现场达成一致：
// 同一个 .dsh-coco/manifest.json、同一个 app.asar.dsh-coco.bak。
// 这个测试手工造出「插件 apply 之后」的现场，再用 CLI --recover 救回来。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const { writeSwapManifest, asarBakPath, manifestPathFor, stateDirFor } = await import(
  path.join(ROOT, "lib", "asar-manifest.js")
);

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failed += 1; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coco-plug-"));
const app = path.join(tmp, "Harness.app");
const res = path.join(app, "Contents", "Resources");
const appDir = path.join(res, "app");
fs.mkdirSync(res, { recursive: true });
const asar = path.join(res, "app.asar");
fs.writeFileSync(asar, Buffer.from("fake-asar-payload"));
const original = sha(asar);

// 模拟插件：先落账，再让位，再放 app/
fs.mkdirSync(path.join(appDir, "dsh", "node_modules", "@deepseek-ai"), { recursive: true });
fs.writeFileSync(path.join(appDir, "dsh", "package.json"), '{"name":"dsh"}');
const manifest = writeSwapManifest(appDir, asar);
ok(fs.existsSync(manifestPathFor(appDir)), "插件写出 manifest");
ok(fs.existsSync(stateDirFor(appDir)), "状态目录在 Resources/.dsh-coco");
fs.renameSync(asar, asarBakPath(asar));
ok(!fs.existsSync(asar) && fs.existsSync(asarBakPath(asar)), "asar 已让位为 .dsh-coco.bak");

console.log("1) CLI --recover 认不认这份现场");
const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "dsh-coco.js"), "--recover", "--app", app], { encoding: "utf8" });
ok(r.status === 0, "recover 退出码 0");
ok(fs.existsSync(asar), "asar 已归位");
ok(sha(asar) === original, "asar 字节级一致");
ok(!fs.existsSync(appDir), "app/ 已删除");
ok(!fs.existsSync(stateDirFor(appDir)), "状态目录已清理");

console.log("2) manifest 字段可被 CLI 解析");
ok(manifest.format === 1, "format=1");
ok(typeof manifest.asar.sha256 === "string" && manifest.asar.sha256.length === 64, "记录 sha256");
ok(typeof manifest.extracted.files === "number", "记录文件数");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
