// 打印当前 DSH 页面状态快照（JSON），供 guard / 人工诊断使用。
// 用法: node dsh-signal.mjs [--pretty]
import { connect, classifyError } from "./dsh-cdp.mjs";
import { snapshot } from "./dsh-actions.mjs";

let c;
try {
  c = await connect();
} catch (e) {
  const kind = classifyError(e);
  console.log(JSON.stringify({ ok: false, reason: kind }));
  process.exit(kind === "NO_PAGE" ? 3 : 2);
}
try {
  const s = await snapshot(c);
  const interrupted =
    !!s && s.errIdxFromEnd !== null && s.errIdxFromEnd <= 4 &&
    /本轮已中止|任务已停止|未完成的工具调用|interrupted/i.test(s.errText || "");
  const out = { ok: true, interrupted, ...s };
  console.log(JSON.stringify(out, null, process.argv.includes("--pretty") ? 2 : 0));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ ok: false, reason: classifyError(e) }));
  process.exit(4);
} finally {
  c.close();
}
