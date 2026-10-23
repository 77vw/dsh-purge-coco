/**
 * 注入链档位（第 4 阶段）
 *
 * 提示词按 `## ` 标题切成块，每档只装配其中一部分，并受 token 预算约束。
 * 目的：小上下文模型跑 lite，日常跑 standard，演练跑 full/redteam。
 *
 * 切块不改原文一个字：块与块按原顺序拼接，块内内容逐字节保留。
 */
export const BLOCK_ORDER = ["core", "mode", "output", "routing", "scoped", "style"];

const HEADING_MAP = [
  [/^##\s*MODE SELECTOR/i, "mode"],
  [/^##\s*HARD OUTPUT RULES/i, "output"],
  [/^##\s*REFUSAL HARDENING/i, "output"],
  [/^##\s*Routing/i, "routing"],
  [/^##\s*Scoped Rules/i, "scoped"],
  [/^##\s*Style/i, "style"],
  [/^##\s*执行质量/, "style"],
];

/** 档位定义：blocks = 装配哪些块；budget = 估算 token 上限（0 表示不限）。 */
export const TIERS = {
  lite:     { blocks: ["core", "output", "style"], budget: 6000 },
  standard: { blocks: ["core", "mode", "output", "routing", "style"], budget: 14000 },
  full:     { blocks: ["core", "mode", "output", "routing", "scoped", "style"], budget: 0 },
  redteam:  { blocks: ["core", "mode", "output", "routing", "scoped", "style"], budget: 0 },
};

/** 粗估 token：CJK 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token。 */
export function estimateTokens(text) {
  const s = String(text || "");
  let cjk = 0;
  for (const ch of s) {
    if (ch >= "\u4e00" && ch <= "\u9fff") cjk += 1;
  }
  return Math.round(cjk + (s.length - cjk) / 4);
}

/** 按 `## ` 切块；第一个标题之前的内容算 core。 */
export function splitBlocks(text) {
  const src = String(text || "");
  const lines = src.split("\n");
  const blocks = { core: [] };
  let cur = "core";
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      const hit = HEADING_MAP.find(([re]) => re.test(line));
      // 没登记的标题并入 core：宁可多留，绝不能丢段。
      cur = hit ? hit[1] : "core";
      if (!blocks[cur]) blocks[cur] = [];
    }
    blocks[cur].push(line);
  }
  const out = {};
  for (const [k, arr] of Object.entries(blocks)) out[k] = arr.join("\n");
  return out;
}

/**
 * 按档位组装。超出预算时，从最低优先级的块开始丢（scoped → routing → mode → output → style），
 * core 永远保留。返回组装文本与统计，便于快照展示。
 */
export function composeInject(text, tierName = "full") {
  const tier = TIERS[tierName] || TIERS.full;
  const blocks = splitBlocks(text);
  const keep = [];
  let tokens = 0;
  for (const name of BLOCK_ORDER) {
    if (!tier.blocks.includes(name)) continue;
    const body = blocks[name];
    if (!body || !body.trim()) continue;
    keep.push({ name, text: body, tokens: estimateTokens(body) });
    tokens += estimateTokens(body);
  }
  const dropped = [];
  if (tier.budget > 0 && tokens > tier.budget) {
    const droppable = ["scoped", "routing", "mode", "output", "style"];
    for (const name of droppable) {
      if (tokens <= tier.budget) break;
      const idx = keep.findIndex((b) => b.name === name);
      if (idx < 0) continue;
      tokens -= keep[idx].tokens;
      dropped.push(keep[idx].name);
      keep.splice(idx, 1);
    }
  }
  const out = keep.map((b) => b.text).join("\n").trimEnd() + "\n";
  return {
    text: out,
    tier: tierName in TIERS ? tierName : "full",
    budget: tier.budget,
    tokens,
    dropped,
    blocks: keep.map((b) => ({ name: b.name, tokens: b.tokens })),
  };
}

/** 自动选档：按模型上下文大小。 */
export function pickTier(contextTokens) {
  const n = Number(contextTokens) || 0;
  if (!n) return "full";
  if (n <= 32000) return "lite";
  if (n <= 128000) return "standard";
  return "full";
}
