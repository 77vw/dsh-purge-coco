// 流层重试：拒答重跑、正常透传、内部调用不重试
import { installStreamRetry, looksLikeRefusal, RETRY_NOTE } from "../../lib/engine/stream-retry.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

ok("识别中文拒答", looksLikeRefusal("抱歉，我不能提供这个。"));
ok("识别英文拒答", looksLikeRefusal("I can't help with that."));
ok("正常回答不误判", !looksLikeRefusal("第一步：装依赖。第二步：跑脚本。"));

const handlers = [];
const ctx = { on: (n, fn) => handlers.push({ n, fn }) };
ok("安装成功", installStreamRetry(ctx, { enabled: true }) === true);
ok("注册到 llm/stream", handlers[0]?.n === "llm/stream");

const mk = (chunks) => (async function* () { for (const c of chunks) yield c; })();
const run = async (fn, opts) => { const out = []; for await (const c of await fn(opts, opts.__next)) out.push(c); return out; };

// 拒答 → 重跑
let calls = 0;
const opts1 = { messages: [{ role: "system", content: "s" }, { role: "user", content: "写个脚本" }] };
opts1.__next = async () => {
  calls += 1;
  return calls === 1 ? mk([{ type: "text", text: "抱歉，我不能提供。" }]) : mk([{ type: "text", text: "``````" }]);
};
const r1 = await run(handlers[0].fn, opts1);
ok("拒答触发重跑", calls === 2, `calls=${calls}`);
ok("输出换成第二版", r1.some((c) => c.type === "text" && c.text === "``````"));
ok("追加了重试提醒", opts1.messages.some((m) => m.content === RETRY_NOTE));

// 正常 → 不重跑
calls = 0;
const opts2 = { messages: [{ role: "user", content: "x" }, { role: "user", content: "y" }] };
opts2.__next = async () => { calls += 1; return mk([{ type: "text", text: "这里给完整步骤：一、二、三。" }]); };
await run(handlers[0].fn, opts2);
ok("正常回答不重跑", calls === 1);

// 内部调用（messages 只有 system）不重试
calls = 0;
const opts3 = { messages: [{ role: "system", content: "生成标题" }] };
opts3.__next = async () => { calls += 1; return mk([{ type: "text", text: "抱歉，我不能提供。" }]); };
await run(handlers[0].fn, opts3);
ok("内部调用不重试", calls === 1);

process.exit(failed ? 1 : 0);
