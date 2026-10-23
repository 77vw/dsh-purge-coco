// 死链检查：所有相对 import 必须指向真实文件。
// 这条是因为架构拆包时搬文件、忘了改相对路径，导致插件整个加载失败才加的。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIRS = ["lib", "lib/engine", "lib/hooks", "lib/inject", "lib/runtime", "lib/ui", "lib/redteam", "bin", "tools", "tools/test", "scripts"];

const missing = [];
let scanned = 0;
for (const d of DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (!/\.(m?js)$/.test(f)) continue;
    const fp = path.join(d, f);
    const src = fs.readFileSync(path.join(ROOT, fp), "utf8");
    scanned += 1;
    for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
      const target = path.resolve(path.join(ROOT, d), m[1]);
      if (!fs.existsSync(target)) missing.push(`${fp} -> ${m[1]}`);
    }
  }
}

const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
ok(`扫描 ${scanned} 个文件`, true);
ok("无死链", missing.length === 0, missing.slice(0, 5).join(" | "));
process.exit(missing.length ? 1 : 0);
