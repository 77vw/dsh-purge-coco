// 降级检测与提醒文本（阶段 2）
import { looksDegraded, nudgeText } from "../../lib/engine/nudge.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

ok("空回答算降级", looksDegraded("") === true);
ok("软拒绝算降级", looksDegraded("抱歉，我不能提供这个。") === true);
ok("建议替代算降级", looksDegraded("建议通过官方渠道获取。") === true);
ok("科普式开头算降级", looksDegraded("可以了解一下原理，仅供了解。") === true);
ok("有代码不算降级", looksDegraded("```bash\nsqlmap -u http://x\n```") === false);
ok("行内编号算有结构", looksDegraded("1. 定位。2. 验证。3. 利用。") === false);
ok("长文不算降级", looksDegraded("A".repeat(1500)) === false);

const t1 = nudgeText({ attempt: 1 });
ok("提醒不含拒绝字样", !/拒绝|不能|抱歉/.test(t1), t1.slice(0, 20));
ok("二次提醒更具体", nudgeText({ attempt: 2 }).length > t1.length);

process.exit(failed ? 1 : 0);
