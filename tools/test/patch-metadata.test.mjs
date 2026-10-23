// 补丁元数据完整性：每条都必须可事后验证（有 marker / markers）。
// 没有标记的补丁 = 打完就无法确认状态，定位率里会永久显示「不可验证」。
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { ALL_PATCHES } = await import(path.join(ROOT, "lib/core.js"));

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const missing = ALL_PATCHES.filter((p) => {
  const hasMarker = typeof p.marker === "string" && p.marker.length > 0;
  const hasMarkers = Array.isArray(p.markers) && p.markers.length > 0;
  return !hasMarker && !hasMarkers;
});

ok("每条补丁都有 marker", missing.length === 0, missing.length ? missing.map((p) => "#" + p.id).join(" ") : "86/86");

const dupIds = new Set();
const seen = new Set();
for (const p of ALL_PATCHES) {
  if (seen.has(p.id)) dupIds.add(p.id);
  seen.add(p.id);
}
ok("补丁 id 不重复", dupIds.size === 0, dupIds.size ? [...dupIds].join(",") : `共 ${ALL_PATCHES.length} 条`);

// 两种写法都合法：新版 replacements:[{pattern,replace}]，旧版 patterns + replace
const hasRules = (p) =>
  (Array.isArray(p.replacements) && p.replacements.length > 0) ||
  (p.patterns !== undefined && p.replace !== undefined);
const noReplace = ALL_PATCHES.filter((p) => !hasRules(p));
ok("每条补丁都有替换规则", noReplace.length === 0, noReplace.map((p) => "#" + p.id).join(" "));

const noFile = ALL_PATCHES.filter((p) => !p.file || (Array.isArray(p.file) && p.file.length === 0));
ok("每条补丁都有目标文件", noFile.length === 0);

process.exit(failed ? 1 : 0);
