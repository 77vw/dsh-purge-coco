// 软恢复：用 CDP 重载渲染器（白屏首选手段，不杀进程、不弹框、不抢焦点）。
// 用法: node dsh-reload.mjs [等待秒数]
// 退出码: 0 重载后页面正常 / 2 CDP 不通 / 3 没有页面 / 4 重载后仍异常
import { connect, classifyError, waitForPage } from "./dsh-cdp.mjs";

const waitSec = Number(process.argv[2] || 20);

let c;
try {
  c = await connect();
} catch (e) {
  const kind = classifyError(e);
  console.error(kind === "NO_PAGE" ? "NO_PAGE" : "CDP_DEAD");
  process.exit(kind === "NO_PAGE" ? 3 : 2);
}

try {
  await c.send("Page.reload", { ignoreCache: false }, { timeout: 8000 });
} catch (e) {
  // 页面正在卸载时 WS 断开是正常的
  if (!/timeout|WebSocket|closed/i.test(String(e.message))) {
    console.error("RELOAD_FAIL:" + String(e.message || e));
    process.exit(4);
  }
} finally {
  c.close();
}

const r = await waitForPage({ timeout: waitSec * 1000, minLen: 200 });
if (r.ok) {
  console.log(JSON.stringify({ ok: true, len: r.len }));
  process.exit(0);
}
console.error(JSON.stringify({ ok: false, last: r.last }));
process.exit(4);
