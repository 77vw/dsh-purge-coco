// safe-apply 的端到端测试：在假 bundle 上跑完整周期，绝不碰 /Applications
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 这套用例依赖 macOS 的 codesign 与 .app bundle，Linux/Windows 上跳过
if (process.platform !== "darwin") {
  console.log("SKIP  safe-apply：只验证 macOS bundle（codesign / .app）");
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, "..", "safe-apply.mjs");

function buildAsar(files) {
  const tree = {};
  const bufs = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const b = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const parts = name.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      node[parts[i]] ??= { files: {} };
      node = node[parts[i]].files;
    }
    node[parts[parts.length - 1]] = { size: b.length, offset: String(offset) };
    bufs.push(b);
    offset += b.length;
  }
  const json = Buffer.from(JSON.stringify({ files: tree }));
  const pad = (4 - (json.length % 4)) % 4;
  const payload = json.length + pad;
  const header = Buffer.alloc(8 + payload);
  header.writeUInt32LE(4 + payload, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(header.length, 4);
  return Buffer.concat([sizePickle, header, ...bufs]);
}

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const run = (cmd, app) => spawnSync(process.execPath, [TOOL, cmd, "--app", app], { encoding: "utf8" });

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coco-safe-"));
const app = path.join(tmp, "Test.app");
const res = path.join(app, "Contents", "Resources");
fs.mkdirSync(res, { recursive: true });
const asar = path.join(res, "app.asar");
fs.writeFileSync(asar, buildAsar({
  "package.json": '{"name":"fake"}',
  "lib/index.js": "console.log('hi')",
  "lib/nested/deep.js": "export const x = 1;",
}));
// 让 fixture 成为一个真正签过名的 .app，才能验证「recover 后签名是否复原」
fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
fs.copyFileSync("/bin/echo", path.join(app, "Contents", "MacOS", "Test"));
fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Test</string>
<key>CFBundleIdentifier</key><string>com.test.coco</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>`);
spawnSync("codesign", ["--force", "--deep", "--sign", "-", app]);

const codesignOk = (p) => spawnSync("codesign", ["--verify", "--deep", "--strict", p], { stdio: "pipe" }).status === 0;

const original = sha(asar);
ok(codesignOk(app), "fixture 初始签名有效");

console.log("1) 干净状态");
let r = run("status", app);
ok(r.stdout.includes("干净"), "status 识别为未 apply");

console.log("2) apply");
r = run("apply", app);
ok(r.status === 0, "apply 退出码 0");
ok(!fs.existsSync(asar), "app.asar 已让位");
ok(fs.existsSync(`${asar}.dsh-coco.bak`), "备份存在");
ok(fs.existsSync(path.join(res, "app", "lib", "nested", "deep.js")), "解包出嵌套文件");
ok(fs.existsSync(path.join(res, ".dsh-coco", "manifest.json")), "manifest 已写");
ok(!codesignOk(app), "apply 后官方签名失效应被检测到（预期行为）");

console.log("3) verify");
r = run("verify", app);
ok(r.status === 0 && r.stdout.includes("✓"), "verify 通过");

console.log("4) 重复 apply 应被拒绝");
r = run("apply", app);
ok(r.status !== 0 && r.stdout.includes("preflight 失败"), "重复 apply 被 preflight 拦住");

console.log("5) recover");
r = run("recover", app);
ok(r.status === 0, "recover 退出码 0");
ok(fs.existsSync(asar), "app.asar 已归位");
ok(sha(asar) === original, "asar 字节级一致");
ok(!fs.existsSync(path.join(res, "app")), "app/ 已删除");
ok(!fs.existsSync(path.join(res, ".dsh-coco")), "状态目录已清理");
ok(codesignOk(app), "recover 后签名恢复有效（原 seal 完整）");

console.log("6) 异常中止：app/ 已存在时不得动 asar");
fs.mkdirSync(path.join(res, "app"), { recursive: true });
const before = sha(asar);
r = run("apply", app);
ok(r.status !== 0, "apply 被拒绝");
ok(sha(asar) === before, "asar 未被改动");

console.log("7) CLI --recover：宿主起不来时的救援通道");
fs.rmSync(path.join(res, "app"), { recursive: true, force: true });
fs.rmSync(path.join(res, ".dsh-coco"), { recursive: true, force: true });
r = run("apply", app);
ok(r.status === 0 && !fs.existsSync(asar), "重新 apply 成功");
const cli = spawnSync(process.execPath, [path.resolve(HERE, "..", "..", "bin", "dsh-coco.js"), "--recover", "--app", app], { encoding: "utf8" });
ok(cli.status === 0, "dsh-coco --recover 退出码 0");
ok(fs.existsSync(asar) && sha(asar) === original, "asar 字节级还原");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
