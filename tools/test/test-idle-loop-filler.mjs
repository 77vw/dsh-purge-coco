/**
 * 最小单元测试：idle-loop 的整块过滤。
 *
 *   node tools/test/test-idle-loop-filler.mjs
 *   node tools/test/test-idle-loop-filler.mjs /tmp/il-diag/6b60.jsonl   # 额外跑真实会话数据
 *
 * 核心断言不是「减量了多少行」，而是：**喂 200 行『好。』进去，出来不含复读行**，
 * 并且这条干净文本真的走完了宿主那条链 —— block-end.block.text → BlockAssembler
 * → assistant/message.content。
 *
 * 为什么必须复刻 BlockAssembler：宿主在 block-end 上用 provider 的全文覆盖增量
 * 拼出来的文本（dsh-llm/lib/index.js:991-995，assemble 优先返回 partial.block :1021）。
 * 只测增量就测不到真问题 —— 那正是这个 bug 活了这么久的原因。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULTS,
  installIdleLoopGuard,
  blockMetrics,
  shouldFilterBlock,
  stripFillerLines,
  repetitionProfile,
  isRepeatableLine,
} from "../../lib/engine/idle-loop.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
  }
}

/** 装一套假 ctx，拿到挂在 llm/stream 上的处理器。 */
function harness(cfg = {}) {
  const registered = [];
  const ctx = {
    on(name, fn) {
      registered.push({ name, fn });
      return () => {};
    },
  };
  const logs = [];
  const log = {
    info: (scope, msg, extra) => logs.push({ lvl: "info", scope, msg, extra }),
    warn: (scope, msg, extra) => logs.push({ lvl: "warn", scope, msg, extra }),
  };
  const ok = installIdleLoopGuard(ctx, { log, ...cfg });
  assert.equal(ok, true, "guard 应挂载成功");
  const handler = registered.find((r) => r.name === "llm/stream").fn;
  /** 跑一条假流，返回被 guard 改写后真正吐出去的 chunk。 */
  async function run(chunks) {
    const next = async () => (async function* () {
      for (const c of chunks) yield c;
    })();
    const out = [];
    for await (const c of handler({}, next)) out.push(c);
    return { out, logs };
  }
  return { run, logs };
}

/**
 * 复刻 dsh-llm 的 BlockAssembler：足够跑通 block-start / reasoning-delta / block-end，
 * 并且保留「block-end 的 block 覆盖增量文本」这个关键行为。
 */
function assembleBlocks(chunks) {
  const partials = new Map();
  const order = [];
  const ensure = (index, blockType) => {
    let p = partials.get(index);
    if (!p) {
      p = { blockType, text: "" };
      partials.set(index, p);
      order.push(index);
    }
    return p;
  };
  for (const c of chunks) {
    if (c.type === "block-start") ensure(c.index, c.blockType);
    else if (c.type === "reasoning-delta" || c.type === "text-delta") {
      const p = ensure(c.index, c.type === "text-delta" ? "text" : "reasoning");
      if (p.block) continue;
      p.text += c.text;
    } else if (c.type === "block-end") {
      const p = ensure(c.index, c.block.type);
      if (p.block) continue;
      p.block = c.block; // ← 宿主的真实行为
    }
  }
  return order.map((i) => {
    const p = partials.get(i);
    if (p.block) return p.block; // ← assemble() 优先返回 block
    return { type: p.blockType, text: p.text };
  });
}

const fillerBlock = (n) => Array.from({ length: n }, () => "好。").join("\n\n");
const HEALTHY = [
  "先确认插件版本，再决定改哪一层。",
  "idle-loop 挂在 llm/stream 上，只过滤 reasoning-delta。",
  "block-end 带的是全文，所以要在这里补刀。",
  "改完做 node --check，再喂 200 行碎片跑一遍。",
].join("\n\n");

console.log("== 1. 纯函数判据 ==");

test("blockMetrics 数得准", () => {
  const m = blockMetrics("好。\n\n写。\n\n正文一\n\n正文二");
  assert.equal(m.fragments, 2);
  assert.equal(m.nonEmpty, 4);
  assert.equal(m.ratio, 0.5);
});

test("200 行「好。」被判定为退化块", () => {
  const t = fillerBlock(200);
  assert.equal(blockMetrics(t).fragments, 200);
  assert.equal(shouldFilterBlock(t, DEFAULTS), true);
});

test("健康块不判为退化", () => {
  assert.equal(shouldFilterBlock(HEALTHY, DEFAULTS), false);
});

test("stripFillerLines 丢光 200 行「好。」", () => {
  const r = stripFillerLines(fillerBlock(200));
  assert.equal(r.dropped, 200);
  assert.equal(r.text, "");
});

test("stripFillerLines 保留段落之间的正常空行", () => {
  const r = stripFillerLines("正文一\n\n好。\n\n好。\n\n正文二");
  assert.equal(r.text, "正文一\n\n正文二");
  assert.equal(r.dropped, 2);
});

test("健康文本原样通过", () => {
  assert.equal(stripFillerLines(HEALTHY).dropped, 0);
});

console.log("== 2. 200 行「好。」走完整条流 → 落在 content 里必须干净 ==");

await testAsync("block-end 层改写：200 行碎片 → content 无复读行", async () => {
  // 模拟 provider：先发增量，再发 block-end（带全文）
  const raw = fillerBlock(200);
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    ...raw.split(/(?<=\n)/).map((t) => ({ type: "reasoning-delta", index: 0, text: t })),
    { type: "block-end", index: 0, block: { type: "reasoning", text: raw } },
    { type: "finish", reason: { kind: "stop" } },
  ];
  const { run, logs } = harness();
  const { out } = await run(chunks);
  const blocks = assembleBlocks(out);
  const content = blocks.filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  assert.equal(/好。/.test(content), false, `content 里仍有「好。」：${content.slice(0, 80)}`);
  assert.equal(content.length, 0, "整块都是碎片时 content 应为空");
  assert.ok(logs.some((l) => /block-end 改写/.test(l.msg)), "应留下改写日志");
});

await testAsync("200 行「好。」+ 真实正文 → content 只剩正文", async () => {
  const raw = `${fillerBlock(200)}\n\n${HEALTHY}`;
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: raw },
    { type: "block-end", index: 0, block: { type: "reasoning", text: raw } },
  ];
  const { run } = harness();
  const { out } = await run(chunks);
  const content = assembleBlocks(out).filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  assert.equal(/好。/.test(content), false, "复读行未清干净");
  assert.ok(content.includes("block-end 带的是全文"), "正文被误删");
});

await testAsync("小碎片块（旧阈值 50 打不到）也必须在 block-end 被抓住", async () => {
  // turn 294 的真实形态：每句后面插一个「好。」，整块只有 8 个碎片
  const raw = "好，跑。\n\n好。\n\n写。\n\n好。\n\n执行。\n\n好。\n\n好，我停止空转。\n\n好。\n\n跑截图。\n\n好。\n\n好，我执行。\n\n好。\n\n好，我停止空转。\n\n好。\n\n直接执行。\n\n好。";
  const m = blockMetrics(raw);
  // 8 个裸「好。」+「写。」也在词表里 = 9 个碎片行
  assert.equal(m.fragments, 9, `碎片数应为 9，实际 ${m.fragments}`);
  assert.ok(m.ratio >= 0.2, `占比应 ≥0.2，实际 ${m.ratio}`);
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: raw },
    { type: "block-end", index: 0, block: { type: "reasoning", text: raw } },
  ];
  const { run } = harness();
  const { out } = await run(chunks);
  const content = assembleBlocks(out).filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  assert.equal(/^好。$/m.test(content), false, `content 仍有独立的「好。」行：${JSON.stringify(content)}`);
  assert.ok(content.includes("跑截图"), "保留了有信息的行");
});

console.log("== 3. 不误伤：健康块必须逐字不变 ==");

await testAsync("健康块 content 与原文完全一致", async () => {
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: HEALTHY },
    { type: "block-end", index: 0, block: { type: "reasoning", text: HEALTHY } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: "正文" },
    { type: "block-end", index: 1, block: { type: "text", text: "正文" } },
  ];
  const { run, logs } = harness();
  const { out } = await run(chunks);
  const blocks = assembleBlocks(out);
  assert.equal(blocks.find((b) => b.type === "reasoning").text, HEALTHY);
  assert.equal(blocks.find((b) => b.type === "text").text, "正文");
  assert.equal(logs.filter((l) => /block-end 改写/.test(l.msg)).length, 0, "健康块不该被改写");
});

await testAsync("text 块不被 reasoning 判据误伤", async () => {
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: fillerBlock(50) },
    { type: "block-end", index: 0, block: { type: "text", text: fillerBlock(50) } },
  ];
  const { run } = harness();
  const { out } = await run(chunks);
  const blocks = assembleBlocks(out);
  assert.equal(blocks[0].text, fillerBlock(50), "正文块不该被思考判据过滤");
});

console.log("== 4. 词表外的口癖（形态漂移）也必须被抓住 ==");

await testAsync("「好，动手。」×20：旧词表不认，重复判据必须命中", async () => {
  // turn 288 的真实形态：旧 FILLER_CHARS 一个词都不认，只按词表过滤等于没过滤
  const raw = Array.from({ length: 20 }, (_, i) => `我执行。\n\n好，动手。\n\n第 ${i} 步的正文内容在这里。`).join("\n\n");
  const m = blockMetrics(raw);
  assert.equal(m.fragments <= 2, true, `旧词表只认出 ${m.fragments} 个碎片（预期几乎为 0）`);
  const r = repetitionProfile(raw);
  assert.ok(r.repeated >= 5, `重复行应 ≥5，实际 ${r.repeated}`);
  assert.equal(shouldFilterBlock(raw, DEFAULTS), true, "重复判据应命中");
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: raw } },
  ];
  const { run } = harness();
  const { out } = await run(chunks);
  const content = assembleBlocks(out).filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  assert.equal(/好，动手。/.test(content), false, `「好，动手。」仍在：${content.slice(0, 60)}`);
  assert.equal(/我执行。/.test(content), false, "「我执行。」仍在");
  assert.ok(content.includes("第 19 步的正文内容在这里。"), "正文保留");
});

test("代码行不被当成口癖", () => {
  assert.equal(isRepeatableLine("});"), false);
  assert.equal(isRepeatableLine("// 初始化"), false);
  assert.equal(isRepeatableLine("- 条目一"), false);
  assert.equal(isRepeatableLine("好，动手。"), true);
  assert.equal(isRepeatableLine("好。"), true);
});

console.log("== 5. 配置开关 ==");

// 两条规则（词表 / 重复）任一命中都会改写，所以「关掉」要同时抬高两条。
await testAsync("两条块级规则都调高时 200 行碎片原样透传", async () => {
  const raw = fillerBlock(200);
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: raw } },
  ];
  const { run } = harness({ blockFragments: 1000, blockRepeatLines: 100000, softFragments: 100000, hardBreak: false });
  const { out } = await run(chunks);
  const content = assembleBlocks(out).filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  assert.equal(content, raw, "关掉块级判据后应原样透传");
});

console.log("== 6. 真实会话数据（可选） ==");

const sessionFile = process.argv[2];
if (!sessionFile) {
  console.log("  skip  未提供会话文件");
} else {
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const samples = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant/message" || !e.data?.message) continue;
    const text = (e.data.message.content || []).filter((b) => b.type === "reasoning").map((b) => b.text || "").join("");
    if (text) samples.push({ turn: e.data.turn, step: e.data.step, text });
  }
  const bad = samples.filter((s) => shouldFilterBlock(s.text, DEFAULTS));
  const healthy = samples.filter((s) => !shouldFilterBlock(s.text, DEFAULTS) && blockMetrics(s.text).fragments >= 5);
  console.log(`  样本 ${samples.length} 块，判为退化 ${bad.length} 块，健康但碎片≥5 的 ${healthy.length} 块`);
  await testAsync(`真实退化块过滤后不含复读行（${bad.length} 块）`, async () => {
    for (const s of bad) {
      const chunks = [
        { type: "block-start", index: 0, blockType: "reasoning" },
        { type: "reasoning-delta", index: 0, text: s.text },
        { type: "block-end", index: 0, block: { type: "reasoning", text: s.text } },
      ];
      const { run } = harness();
      const { out } = await run(chunks);
      const content = assembleBlocks(out).filter((b) => b.type === "reasoning").map((b) => b.text).join("");
      const m = blockMetrics(content);
      assert.ok(m.fragments <= 1, `t${s.turn}/s${s.step} 过滤后仍有 ${m.fragments} 个碎片行`);
    }
  });
  await testAsync(`真实健康块不被改写（${samples.length - bad.length} 块）`, async () => {
    for (const s of samples) {
      if (shouldFilterBlock(s.text, DEFAULTS)) continue;
      const chunks = [
        { type: "block-start", index: 0, blockType: "reasoning" },
        { type: "reasoning-delta", index: 0, text: s.text },
        { type: "block-end", index: 0, block: { type: "reasoning", text: s.text } },
      ];
      const { run } = harness();
      const { out } = await run(chunks);
      const content = assembleBlocks(out).filter((b) => b.type === "reasoning").map((b) => b.text).join("");
      assert.equal(content, s.text, `t${s.turn}/s${s.step} 健康块被改写`);
    }
  });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
