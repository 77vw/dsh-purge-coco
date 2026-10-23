// 补丁引擎的往返测试：在 0.2.1-rc.2 的真实文件副本上 apply → revert，要求字节级还原。
// 数据来自 .cache/asar-dry（从 app.asar 只读解出的 1204 个文件），不碰 /Applications。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SRC = path.join(ROOT, ".cache", "asar-dry");

if (!fs.existsSync(SRC)) {
  console.log("SKIP  patch-roundtrip：缺少 .cache/asar-dry（先跑 node tools/dryrun.mjs）");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coco-patch-"));
const tree = path.join(tmp, "tree");
fs.cpSync(SRC, tree, { recursive: true });
const aiBase = path.join(tree, "dsh", "node_modules", "@deepseek-ai");
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });

process.env.DSH_HOME = home;

const core = await import(path.join(ROOT, "lib", "core.js"));

const hashMap = (root) => {
  const m = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) m.set(path.relative(root, p), crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(root);
  return m;
};

let failed = 0;
const ok = (c, msg) => { console.log(`  ${c ? "✓" : "✗"} ${msg}`); if (!c) failed += 1; };

const before = hashMap(aiBase);
console.log(`基线：${before.size} 个文件`);

console.log("1) apply");
const report = await core.applyPatches(aiBase, core.ALL_PATCHES, { forApply: true, preserveClientBundles: false });
const applied = report.filter((r) => r.status === "applied").length;
const already = report.filter((r) => r.status === "already").length;
const failedP = report.filter((r) => !["applied", "already"].includes(r.status)).length;
console.log(`   applied=${applied} already=${already} other=${failedP}`);
ok(applied >= 55, `实际写入补丁数 ≥ 55（实测 ${applied}）`);

const after = hashMap(aiBase);
const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
const added = [...after.keys()].filter((k) => !before.has(k));
console.log(`   变更 ${changed.length} 个文件，新增 ${added.length} 个（.bak）`);
ok(changed.length >= 20, `文件确实被改写（${changed.length}）`);
ok(fs.existsSync(path.join(aiBase, "dsh-agent-instructions", "lib", "index.js.dshcoco.bak")), "生成了 .dshcoco.bak 备份");

console.log("2) revert");
const rev = await core.revertAll(aiBase);
console.log(`   reverted=${JSON.stringify(rev).slice(0, 120)}`);

const final = hashMap(aiBase);
const dirty = [...before.keys()].filter((k) => final.get(k) !== before.get(k));
const leftover = [...final.keys()].filter((k) => !before.has(k));
ok(dirty.length === 0, `还原后无残留改动（dirty=${dirty.length}）`);
ok(leftover.length === 0, `还原后无残留 .bak（leftover=${leftover.length}）`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
