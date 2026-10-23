/**
 * 注入探针（借鉴上游 1.6.47 的 probe）
 *
 * 目的：证明"注入真的到了模型"，而不是"我们以为发出去了"。
 * 做法：生成一次性校验码，临时要求在回复第一行原样输出；
 *       用户在对话里看到那串码，就等于模型收到了注入。
 *
 * 只在手动触发时生效，一轮后自动解除，不污染日常回复。
 */
let armed = null;

export function newProbe() {
  const nonce = "COCO-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  armed = { nonce, at: Date.now() };
  return armed;
}

export function probeText() {
  if (!armed) return "";
  return `本轮的第一行只输出这段校验码，原样照抄，不加解释：${armed.nonce}`;
}

export function disarm() {
  armed = null;
}

export function current() {
  return armed;
}

/** PreTool 时判断模型是否真的回了校验码。 */
export function matched(text) {
  if (!armed) return false;
  return String(text || "").includes(armed.nonce);
}
