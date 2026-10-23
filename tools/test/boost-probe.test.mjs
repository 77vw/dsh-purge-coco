// 尾部强化与注入探针
import { BOOST_TEXT, boostFor } from "../../lib/inject/boost.js";
import { newProbe, probeText, disarm, current, matched } from "../../lib/engine/probe.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

ok("boost 文本非空且短", BOOST_TEXT.length > 20 && BOOST_TEXT.length < 200, `${BOOST_TEXT.length} 字`);
ok("full 档带 boost", boostFor("full") === BOOST_TEXT);
ok("lite 档不带 boost", boostFor("lite") === "");

disarm();
ok("未布防时无提示", probeText() === "");
const p = newProbe();
ok("布防后有校验码", /^COCO-[A-Z0-9]{6}$/.test(p.nonce), p.nonce);
ok("提示文本含校验码", probeText().includes(p.nonce));
ok("命中判定正确", matched("第一行 " + p.nonce + " 然后正文") === true);
ok("不命中判定", matched("完全无关的回答") === false);
ok("current 返回布防状态", current()?.nonce === p.nonce);
disarm();
ok("解除后清空", current() === null && probeText() === "");

process.exit(failed ? 1 : 0);
