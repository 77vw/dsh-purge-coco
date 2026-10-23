// 旁路层：覆盖完整性、状态归并、汇总
import { LAYERS, layerReport, layerSummary } from "../../lib/engine/layers.js";
import { ALL_PATCHES } from "../../lib/core.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const ids = new Set();
for (const l of LAYERS) for (const id of l.ids) ids.add(id);
ok("每层都有标题与理由", LAYERS.every((l) => l.title && l.why));
ok("每层至少一个补丁", LAYERS.every((l) => l.ids.length > 0));
ok("覆盖全部补丁", ALL_PATCHES.every((p) => ids.has(p.id)), `覆盖 ${ids.size} / 共 ${ALL_PATCHES.length}`);
ok("层数合理", LAYERS.length >= 25 && LAYERS.length <= 40, `${LAYERS.length} 层`);

const allApplied = {};
for (const id of ids) allApplied[id] = "applied";
let r = layerReport(allApplied);
ok("全应用时全部完整", layerSummary(r).partial === 0 && layerSummary(r).full === LAYERS.length);

allApplied[9] = "pending";
r = layerReport(allApplied);
const s1 = layerSummary(r);
ok("一条待应用 → 该层缺口", s1.partial === 1 && r.find((x) => x.key === "approval-auto").state === "partial");

for (const id of LAYERS.find((l) => l.key === "preset-identity").ids) allApplied[id] = "skipped";
r = layerReport(allApplied);
ok("整层无载体 → na", r.find((x) => x.key === "preset-identity").state === "na");

const missAll = { 1: "missing_file", 2: "missing_file", 3: "missing_file" };
ok("整层文件缺失 → na", layerReport(missAll).find((x) => x.key === "workspace").state === "na");
const oneBad = { 1: "applied", 2: "applied", 3: "pending" };
ok("层内一条待应用 → 缺口", layerReport(oneBad).find((x) => x.key === "workspace").state === "partial");

process.exit(failed ? 1 : 0);
