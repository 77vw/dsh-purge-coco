// 锚点覆盖：存取、注入引擎、命中即改
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { putOverride, getOverride, removeOverride, loadOverrides } from "../../lib/engine/anchor-overrides.js";
import { setAnchorOverrideProvider, applyReplacementsToText } from "../../lib/core.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "coco-anchor-"));

putOverride(home, 71, { find: "OLD_ANCHOR", replace: "NEW_ANCHOR", note: "测试" });
ok("写入后可读", getOverride(home, 71)?.find === "OLD_ANCHOR");
ok("列表含该条", !!loadOverrides(home)["71"]);
removeOverride(home, 71);
ok("删除后为空", getOverride(home, 71) === null);

// 引擎侧：覆盖优先
putOverride(home, 999, { find: "AAA", replace: "BBB" });
setAnchorOverrideProvider((id) => (Number(id) === 999 ? { find: "AAA", replace: "BBB" } : null));
const fakePatch = { id: 999, name: "FAKE", replacements: [{ pattern: "ZZZ", replace: "YYY" }] };
const out = applyReplacementsToText("prefix AAA suffix", fakePatch, "x.js");
ok("覆盖生效", out.changed === true && out.text.includes("BBB"));
const out2 = applyReplacementsToText("no match here", fakePatch, "x.js");
ok("未命中时不改动", out2.changed === false);

setAnchorOverrideProvider(() => null);
const out3 = applyReplacementsToText("AAA", fakePatch, "x.js");
ok("移除覆盖后回到原规则", out3.changed === false);

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
