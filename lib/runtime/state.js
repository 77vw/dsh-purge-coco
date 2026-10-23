/**
 * 运行时层状态登记表。
 * 每个安装器装成功就登记一行，供状态接口和设置页展示。
 * 这不影响行为，只是让「到底哪层在生效」可观测。
 */
const state = new Map();

export function record(name, ok, detail = "") {
  state.set(name, { ok: !!ok, detail, at: Date.now() });
  return !!ok;
}

export function snapshot() {
  const out = {};
  for (const [k, v] of state) out[k] = v;
  return out;
}

export function reset() {
  state.clear();
}
