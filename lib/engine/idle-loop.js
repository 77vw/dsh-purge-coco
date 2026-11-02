/**
 * 上下文空转治理（阶段 8 · anti idle-loop）
 *
 * 现象：长上下文 + 步数多时，模型把思考退化成对最短祈使句的自我复读：
 *
 *     做。
 *     做。
 *     **写 service。**
 *     做。
 *     （连续 3,619 行）
 *
 * 一轮能烧 15,000 个输出 token，正文和工具调用其实只有几行。用户看到的就是「空转」。
 *
 * 为什么不能只靠压缩阈值：把窗口压小只是降低概率，退化一旦起来仍会烧满。
 * 为什么不能只靠社区守卫：它的门禁用 `isAgentLoopRequest`（WeakSet 身份判定），
 * 插件解析到另一份 dsh-llm 副本时恒为 false，静默透传，功能全废。
 *
 * 这里挂在 coco 自己的流层上（和 stream-retry 同一层），只做两件事：
 *
 *   1 软阈值（碎片 ≥ softFragments 且密度 ≥ softDensity）
 *      → 不再转发 reasoning-delta，但让流继续跑。模型的正文和工具调用照常出来，
 *        只把复读挡在上下文之外，下一轮不会再拿它当「我刚才在想什么」的模板。
 *   2 硬阈值（碎片 ≥ hardFragments 且密度 ≥ hardDensity）
 *      → 切断这一条流，返回 finish。一句 15,000 token 的「做。」不值得付，
 *        让它下一轮从头来更便宜。
 *
 * 标定（本机 8 个最大会话、5,343 个真实思考块）：
 *   · 健康会话单块碎片上限 49，退化会话 50–3,637；
 *   · 软阈值 50 命中退化块 553/553，误报 0；
 *   · 硬阈值 800 只命中真正的失控块（3,637 那类），826 字符/50 碎片的正常中文思考不碰。
 */

/**
 * 复读用的祈使碎片。整行 1–4 字、全部取自这里，才算一个碎片。
 *
 * 这张表刻意窄：字符集每放宽一个常用动词（「查」「测」「看」「改」），
 * 正常的分步提纲就会多算几个碎片，阈值余量立刻被吃掉。
 * 本机 8,039 个真实思考块上，这个集合的健康块上限是 49 个碎片、退化块 553 个全部 ≥50。
 */
const FILLER_CHARS = new Set("好做写等分对行停继续结束收尾完嗯");

/** 行首的 markdown / 缩进噪声。 */
const LEAD = /^[\s>*•·\-–—]+/;
/** 行尾标点。`做。` 和 `做` 视为同一个碎片。 */
const TAIL = /[。.！!？?、,，;；:：…\s]+$/;

/** 这一行是不是纯粹的祈使碎片。 */
export function isFillerLine(line) {
  let t = String(line == null ? "" : line).replace(LEAD, "").replace(TAIL, "");
  if (!t) return false;
  if (t.length > 4) return false;
  for (const ch of t) {
    if (!FILLER_CHARS.has(ch)) return false;
  }
  return true;
}

/** 一段文本里有多少个碎片行。用于离线复核，不参与流内判定。 */
export function countFillerLines(text) {
  const raw = String(text == null ? "" : text);
  if (!raw) return 0;
  let n = 0;
  for (const line of raw.split("\n")) {
    if (isFillerLine(line)) n += 1;
  }
  return n;
}

/**
 * 整块的碎片画像：字符数、非空行数、碎片行数、碎片行占非空行的比例。
 *
 * 为什么需要「比例」而不只是「计数」：
 * 有一种退化形态不靠单块堆积 —— 模型每写完一句就插一个 `好。` 加一个空行，
 * 于是一整块只有 8–20 个碎片行、84–500 字符。计数阈值（≥50）永远不达标，
 * 而人一眼就看得出整块在说「好。」。比例能把这种「薄但持续」的形态抓住。
 */
export function blockMetrics(text) {
  const raw = String(text == null ? "" : text);
  const lines = raw.split("\n");
  let fragments = 0;
  let nonEmpty = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    nonEmpty += 1;
    if (isFillerLine(line)) fragments += 1;
  }
  return {
    chars: raw.length,
    lines: lines.length,
    nonEmpty,
    fragments,
    ratio: nonEmpty > 0 ? fragments / nonEmpty : 0,
  };
}

/** 行尾标点，和 isFillerLine 用同一套。 */
const TIC_TAIL = /[。.！!？?、,，;；:：…\s]+$/;
/**
 * 代码噪声。带这些字符的行一律不算「口癖行」：
 * 退化的口癖是纯中文短语，而 `});`、`// TODO`、`- item` 不是。
 * 10 含有中文字符的代码注释也靠这一条被挡在外面。
 */
const ASCII_NOISE = /[A-Za-z0-9{}[\]()<>;,.=|&*/\\#$%^~@'"`_+\-]/;

/** 一行的归一化形态：去首尾空白与行尾标点。 */
export function ticKey(line) {
  return String(line == null ? "" : line).trim().replace(TIC_TAIL, "").trim();
}

/**
 * 这一行有没有资格被当成「口癖行」：短，且不含任何代码/字母数字噪声。
 *
 * 为什么不复用 FILLER_CHARS 词表：实测退化词汇会漂移。turn 288 的块里
 * 复读的是 `好，动手。` `我执行。` `我查。`，这三个词旧词表一个都不认；
 * 只按词表过滤，会留下一整屏这样的行 —— 用户看到的仍然没变。
 * 「短 + 纯中文 + 块内反复出现」是这些形态共同的结构特征，不必枚举词汇。
 */
export function isRepeatableLine(line) {
  const k = ticKey(line);
  if (!k || k.length > 8) return false;
  return !ASCII_NOISE.test(k);
}

/**
 * 块内重复画像：出现 ≥3 次的短中文行有多少条、占非空行多少。
 *
 * 退化块的共同点是「同一句短话反复出现」，健康块几乎不会这样 ——
 * 本机 438 个真实健康块上，这个判据误报 0。
 */
export function repetitionProfile(text) {
  const raw = String(text == null ? "" : text);
  const counts = new Map();
  let nonEmpty = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    nonEmpty += 1;
    if (!isRepeatableLine(line)) continue;
    const k = ticKey(line);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let repeated = 0;
  const keys = new Set();
  for (const [k, n] of counts) {
    if (n < 3) continue;
    repeated += n;
    keys.add(k);
  }
  return {
    repeated,
    keys,
    nonEmpty,
    ratio: nonEmpty > 0 ? repeated / nonEmpty : 0,
  };
}

/**
 * 整块级判据：这一整块思考是不是退化块。
 *
 * 两条规则，任一命中即判退化：
 *
 *   A 词表碎片：frag ≥5 且 占比 ≥0.20（抓 `好。/写。/执行。` 类）
 *   B 块内重复：重复行 ≥5 且 占比 ≥0.15（抓 `好，动手。/我执行。` 这类表外口癖）
 *
 * 标定（本机 9 个健康会话 438 个块 + 3 个退化会话）：
 *   · 健康块：规则 A 误报 0/438，规则 B 误报 0/438；
 *   · turn 294（每句后插 `好。`，每块 8–20 个碎片）：A 命中 27/27；
 *   · turn 288（`好，动手。` 复读块）：B 命中，A 只认出其中一部分。
 */
export function shouldFilterBlock(text, opts = {}) {
  const m = blockMetrics(text);
  const r = repetitionProfile(text);
  const minFrag = Number.isFinite(opts.blockFragments) ? opts.blockFragments : 5;
  const minRatio = Number.isFinite(opts.blockRatio) ? opts.blockRatio : 0.2;
  const minChars = Number.isFinite(opts.blockChars) ? opts.blockChars : 60;
  const minRepeat = Number.isFinite(opts.blockRepeatLines) ? opts.blockRepeatLines : 5;
  const minRepeatRatio = Number.isFinite(opts.blockRepeatRatio) ? opts.blockRepeatRatio : 0.15;
  if (m.chars < minChars) return false;
  const byVocabulary = m.fragments >= minFrag && m.ratio >= minRatio;
  const byRepetition = r.repeated >= minRepeat && r.ratio >= minRepeatRatio;
  return byVocabulary || byRepetition;
}

/**
 * 丢掉口癖行，以及「因为丢了口癖行才变成孤立」的空行。
 *
 * 关键词：正常段落之间的空行必须留下。所以空行先攒着，等后面出现真正的内容行
 * 才一起放出去；块尾悬空的那批空行直接丢。这样 `内容\n\n好。\n\n好。\n\n内容2`
 * 变成 `内容\n\n内容2`，而不是被压成一整块。
 *
 * 丢的行 = 词表碎片行 ∪ 块内出现 ≥3 次的短中文行。后者是必要的：
 * 只按词表丢 `好。`，`好，动手。` 会原样留着，屏幕上还是成片复读。
 */
export function stripFillerLines(text) {
  const raw = String(text == null ? "" : text);
  if (!raw) return { text: raw, dropped: 0 };
  const repeated = repetitionProfile(raw).keys;
  const out = [];
  let dropped = 0;
  let blanks = [];
  for (const line of raw.split("\n")) {
    const isJunk = isFillerLine(line)
      || (repeated.size > 0 && isRepeatableLine(line) && repeated.has(ticKey(line)));
    if (isJunk) {
      dropped += 1;
      blanks = [];
      continue;
    }
    if (line.trim() === "") {
      blanks.push(line);
      continue;
    }
    for (const b of blanks) out.push(b);
    blanks = [];
    out.push(line);
  }
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return { text: out.join("\n"), dropped };
}

/**
 * 增量碎片计米器。
 *
 * 只扫新出现的行；未闭合的尾行用瞬时判定（不落进计数），
 * 这样「做。」写成「做完了」时不会留下一条假账。
 */
export class FragmentMeter {
  constructor() {
    this.raw = "";
    this.scanned = 0;
    this.complete = 0;
    this.streak = 0;
    this.maxStreak = 0;
  }

  push(delta) {
    const add = String(delta == null ? "" : delta);
    if (!add) return;
    this.raw += add;
    let idx = this.raw.indexOf("\n", this.scanned);
    while (idx !== -1) {
      const line = this.raw.slice(this.scanned, idx);
      if (isFillerLine(line)) {
        this.complete += 1;
        this.streak += 1;
        if (this.streak > this.maxStreak) this.maxStreak = this.streak;
      } else if (line.trim() !== "") {
        // 复读的碎片之间几乎总夹着空行（`做。\n\n做。\n\n`），
        // 空行不算打断；只有出现真正的别的内容才把连续计数清零。
        this.streak = 0;
      }
      this.scanned = idx + 1;
      idx = this.raw.indexOf("\n", this.scanned);
    }
  }

  /** 已生成字符数。 */
  get chars() {
    return this.raw.length;
  }

  /** 是否正卡在一个碎片行中间。 */
  get tailIsFiller() {
    return isFillerLine(this.raw.slice(this.scanned));
  }

  /** 碎片总数（含当前未闭合的尾行）。 */
  get fragments() {
    return this.complete + (this.tailIsFiller ? 1 : 0);
  }

  /** 每千字符的碎片数。 */
  get density() {
    return this.chars > 0 ? (this.fragments / this.chars) * 1000 : 0;
  }
}

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 软阈值：进入「不再转发思考」模式 */
  softFragments: 50,
  softDensity: 5,
  /** 短块不判：一整块思考还很短时，分步提纲本来就长这样 */
  softChars: 128,
  /** 硬阈值：切断这一条流 */
  hardFragments: 800,
  hardDensity: 100,
  /** 硬阈值是否真的切断；关掉就只做软抑制 */
  hardBreak: true,
  /**
   * 整块级判据（真正的兜底）。
   *
   * 必须有这一层，因为宿主把整块思考的**原文**放在 `block-end.block.text` 里：
   * dsh-llm `BlockAssembler.push` 收到 block-end 会直接 `partial.block = chunk.block`
   * （dsh-llm/lib/index.js:991-995），`assemble()` 又优先返回它（:1021）。
   * 也就是说：只过滤 `reasoning-delta` 增量，最终落地到
   * `assistant/message.content[]` 的仍然是 provider 自带的完整原文。
   */
  blockFragments: 5,
  blockRepeatLines: 5,
  blockRepeatRatio: 0.15,
  blockRatio: 0.2,
  blockChars: 60,
});

function reasoningTextOf(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.type === "reasoning-delta" || chunk.type === "reasoning") {
    return typeof chunk.text === "string" ? chunk.text : "";
  }
  return null;
}

/**
 * 挂到宿主 llm/stream 上。
 *
 * @param {object} ctx 宿主上下文
 * @param {object} opts 见 DEFAULTS，外加 { log }
 * @returns {boolean} 是否挂上
 */
export function installIdleLoopGuard(ctx, opts = {}) {
  const cfg = { ...DEFAULTS };
  // 调用方为了可读会写 `config?.x` 的三元，未配置时是 undefined；
  // 直接展开会让 undefined 覆盖掉默认值，这里逐个滤掉。
  for (const [k, v] of Object.entries(opts || {})) {
    if (v !== undefined) cfg[k] = v;
  }
  const log = cfg.log || null;
  if (!cfg.enabled) return false;
  if (!ctx || typeof ctx.on !== "function") return false;
  try {
    // 监听器必须「同步返回 async iterable」；写成 async 函数会返回 Promise，
    // 宿主会报 "stream is not async iterable"。await 放进生成器内部。
    ctx.on(
      "llm/stream",
      (options, next) => {
        let meter = new FragmentMeter();
        // 触发之后不再「整段丢弃 / 整段放行」地来回震：复读是交替形态
        // （`做。\n\n**写 service。**\n\n做。`），开关式抑制会每两行抖一次。
        // 改成行级过滤：碎片行丢掉，别的行照常转发。
        let filtering = false;
        let pending = "";
        let droppedLines = 0;
        // 整块兜底：provider 在 block-end 里带的是**全文**，不经这里改写就会
        // 原封不动进 assistant/message.content，增量过滤等于白做。
        let blockRewrites = 0;
        let blockDroppedLines = 0;

        const takeLines = (text, final) => {
          pending += text;
          const out = [];
          let idx = pending.indexOf("\n");
          while (idx !== -1) {
            out.push(pending.slice(0, idx + 1));
            pending = pending.slice(idx + 1);
            idx = pending.indexOf("\n");
          }
          // 单行超长时不无限攒：4 KB 还没换行就当作完整行放出去
          if (!final && pending.length > 4096) {
            out.push(pending);
            pending = "";
          }
          if (final && pending) {
            out.push(pending);
            pending = "";
          }
          return out;
        };

        return (async function* () {
          const stream = await next();
          for await (const chunk of stream) {
            // 整块收尾：这是唯一能真正改到 assistant/message.content 的口子。
            // provider 自带的 block-end 携带整块原文（dsh-llm-deepseek/lib/index.js:1985-1989），
            // 而 BlockAssembler 会用它直接覆盖增量拼出来的文本（dsh-llm/lib/index.js:991-995、:1021）。
            // 所以增量过滤再干净，不改这里，落进会话日志和 UI 的仍是原文。
            if (chunk && chunk.type === "block-end" && chunk.block
              && chunk.block.type === "reasoning" && typeof chunk.block.text === "string") {
              const blockText = chunk.block.text;
              const metrics = blockMetrics(blockText);
              const overdue = shouldFilterBlock(blockText, cfg);
              if (overdue) {
                const cleaned = stripFillerLines(blockText);
                if (cleaned.dropped > 0) {
                  blockRewrites += 1;
                  blockDroppedLines += cleaned.dropped;
                  log?.info?.("idle-loop", "整块思考复读行已在 block-end 改写", {
                    fragments: metrics.fragments,
                    nonEmpty: metrics.nonEmpty,
                    ratio: Math.round(metrics.ratio * 100) / 100,
                    chars: metrics.chars,
                    droppedLines: cleaned.dropped,
                    keptChars: cleaned.text.length,
                  });
                  meter = new FragmentMeter();
                  filtering = false;
                  pending = "";
                  yield { ...chunk, block: { ...chunk.block, text: cleaned.text } };
                  continue;
                }
              }
              // 判完就重置：下一块独立判定，不被上一块的碎片拖累。
              meter = new FragmentMeter();
              filtering = false;
              pending = "";
              yield chunk;
              continue;
            }

            const text = reasoningTextOf(chunk);
            if (text === null) {
              yield chunk;
              continue;
            }
            meter.push(text);

            if (cfg.hardBreak && meter.fragments >= cfg.hardFragments && meter.density >= cfg.hardDensity) {
              log?.warn?.("idle-loop", "思考原地复读超硬阈值，切断本轮", {
                fragments: meter.fragments,
                chars: meter.chars,
                density: Math.round(meter.density),
              });
              return {
                type: "finish",
                reason: {
                  kind: "error",
                  failure: {
                    message: `思考原地复读（${meter.fragments} 个碎片 / ${meter.chars} 字符），本轮已切断。`,
                  },
                },
              };
            }

            if (!filtering
              && meter.fragments >= cfg.softFragments
              && meter.density >= cfg.softDensity
              && meter.chars >= cfg.softChars) {
              filtering = true;
              pending = "";
              log?.warn?.("idle-loop", "思考碎片密度超阈值，开始过滤复读行", {
                fragments: meter.fragments,
                chars: meter.chars,
                density: Math.round(meter.density),
              });
            }

            if (!filtering) {
              yield chunk;
              continue;
            }

            const kept = [];
            for (const line of takeLines(text, false)) {
              // 复读的碎片之间夹着空行，一并丢掉；否则留下的是成片空行。
              if (isFillerLine(line) || line.trim() === "") {
                droppedLines += 1;
                continue;
              }
              kept.push(line);
            }
            if (kept.length) {
              yield { ...chunk, text: kept.join("") };
            }
          }

          if (filtering) {
            const kept = [];
            for (const line of takeLines("", true)) {
              if (isFillerLine(line) || line.trim() === "") droppedLines += 1;
              else kept.push(line);
            }
            if (kept.length) yield { type: "reasoning-delta", index: 0, text: kept.join("") };
            log?.info?.("idle-loop", "本轮思考复读行已过滤", {
              fragments: meter.fragments,
              droppedLines,
              chars: meter.chars,
            });
          }

          if (blockRewrites > 0) {
            log?.info?.("idle-loop", "本轮整块思考已在 block-end 层改写", {
              blockRewrites,
              blockDroppedLines,
            });
          }
        })();
      },
      { global: true, prepend: true },
    );
    return true;
  } catch (e) {
    log?.warn?.("idle-loop", "挂载失败", { error: String((e && e.message) || e) });
    return false;
  }
}
