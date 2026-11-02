// 往正在运行的 DSH 会话输入框发一条消息（纯 CDP，不抢前台，不需要窗口焦点）
// 用法: node dsh-say.mjs "要发的内容" [--force]
// 退出码: 0 成功 / 2 CDP 不通 / 3 没有页面 / 4 没有输入框 / 6 会话忙或有草稿（加 --force 强制）
import { connect, classifyError } from "./dsh-cdp.mjs";
import { sendMessage } from "./dsh-actions.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const text = args.find((a) => a !== "--force");
if (!text) {
  console.error("用法: node dsh-say.mjs <内容> [--force]");
  process.exit(1);
}

let c;
try {
  c = await connect();
} catch (e) {
  const kind = classifyError(e);
  console.error(kind === "NO_PAGE" ? "NO_PAGE" : "CDP_DEAD");
  process.exit(kind === "NO_PAGE" ? 3 : 2);
}

try {
  const r = await sendMessage(c, text, { force });
  if (!r.ok) {
    if (r.reason === "busy" || r.reason === "draft-exists") {
      console.error(`${r.reason === "busy" ? "BUSY" : "DRAFT_EXISTS"}: 未发送（--force 可强制）`);
      process.exit(6);
    }
    console.error("失败: " + r.reason);
    process.exit(4);
  }
  console.log(JSON.stringify(r));
  process.exit(0);
} catch (e) {
  console.error("失败: " + String(e.message || e));
  process.exit(5);
} finally {
  c.close();
}
