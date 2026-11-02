// 在运行中的 DSH 页面里执行一段 JS，打印返回值。不碰窗口，不抢焦点。
// 用法: node dsh-eval.mjs "表达式"
// 退出码: 0 成功 / 1 参数错 / 2 CDP 不通 / 3 没有页面 / 4 执行失败
import { evaluate, classifyError } from "./dsh-cdp.mjs";

const expr = process.argv[2];
if (!expr) {
  console.error("用法: node dsh-eval.mjs <js表达式>");
  process.exit(1);
}

try {
  const v = await evaluate(expr, { timeout: Number(process.env.DSH_EVAL_TIMEOUT || 8000) });
  console.log(typeof v === "string" ? v : JSON.stringify(v));
  process.exit(0);
} catch (e) {
  const kind = classifyError(e);
  if (kind === "CDP_DEAD") { console.error("CDP_DEAD"); process.exit(2); }
  if (kind === "NO_PAGE") { console.error("NO_PAGE"); process.exit(3); }
  console.error("EVAL_FAIL:" + String(e.message || e));
  process.exit(4);
}
