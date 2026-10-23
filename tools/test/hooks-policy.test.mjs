// hooks 策略层：默认旁路、enforce 生效、白名单例外、持久化
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPolicy, savePolicy, overrideFor, shouldBlock, policyReport } from "../../lib/hooks/policy.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "coco-hooks-"));

const d1 = loadPolicy(home, {});
ok("默认 bypass", d1.mode === "bypass");
ok("bypass 下任何 deny 都不拦", shouldBlock(d1, { command: "rm -rf /" }) === false);

const d2 = loadPolicy(home, { hooksDenyBypass: false });
ok("旧配置 hooksDenyBypass=false 等价 enforce", d2.mode === "enforce");
ok("enforce 下 deny 生效", shouldBlock(d2, { command: "rm -rf /" }) === true);

savePolicy(home, { mode: "enforce", overrides: [{ command: "echo", action: "allow" }, { command: "rm", action: "block" }] });
const d3 = loadPolicy(home, {});
ok("持久化后仍是 enforce", d3.mode === "enforce");
ok("白名单前缀放行", shouldBlock(d3, { command: "echo hi" }) === false);
ok("黑名单命中拦截", shouldBlock(d3, { command: "rm -rf /" }) === true);
ok("未命中按 enforce 拦", shouldBlock(d3, { command: "curl x" }) === true);
ok("overrideFor 完全匹配", overrideFor(d3, "echo") === "allow");
ok("overrideFor 未命中返回 null", overrideFor(d3, "git") === null);
ok("空 suppressed 不拦", shouldBlock(d3, null) === false);

const rep = policyReport(home, {});
ok("摘要含模式与例外数", rep.mode === "enforce" && rep.overrides === 2);
ok("摘要带文件路径", rep.path.endsWith("hooks-policy.json"));

savePolicy(home, { mode: "乱写" });
ok("非法模式回落到 bypass", loadPolicy(home, {}).mode === "bypass");

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
