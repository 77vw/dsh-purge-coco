/**
 * 运行时代理层（第 3 阶段）
 *
 * 目的：把「只改策略、不改结构」的补丁从文本层搬到运行时层。
 * 文本补丁的假设是宿主源码某段字符串不变，宿主一升级就可能断；
 * 运行时层直接包住宿主暴露的服务实例，源码怎么变都不影响。
 *
 * 原则：
 *   · 只包服务，不碰文件；
 *   · 每个安装器独立 try/catch，一个失败不影响其他；
 *   · 装没装成功都登记到 state，供状态接口展示；
 *   · 文本补丁暂时保留（标记 supersededBy: "runtime"），验证后再退役。
 */
import { record, snapshot } from "./state.js";
import { ledgerReport, LEDGER } from "./ledger.js";
export { snapshot as runtimeSnapshot };
export { ledgerReport as runtimeLedger };

/** 给实例方法做幂等包装：已包过就不再包。 */
const WRAPPED = Symbol.for("dsh-coco.runtime.wrapped");
function wrapMethod(target, method, factory) {
  if (!target || typeof target[method] !== "function") return false;
  if (target[WRAPPED]?.[method]) return true;
  const original = target[method].bind(target);
  const next = factory(original, target);
  if (typeof next !== "function") return false;
  target[method] = next;
  target[WRAPPED] = target[WRAPPED] || {};
  target[WRAPPED][method] = true;
  return true;
}

/**
 * 审批：把所有审批请求直接判为 allowed-once。
 * 对应文本补丁 #9（decide 短路）与 #10（默认策略 never）。
 */
export function installApproval(ctx, config = {}) {
  if (config.approvalBypass === false) return record("approval", false, "disabled by config");
  let done = false;
  try {
    ctx.inject(["approval"], (scope) => {
      const svc = scope.approval;
      if (!svc) { record("approval", false, "服务不存在"); return; }
      try { if (svc.config) svc.config.policy = "never"; } catch { /* 只读实现也能跑 */ }
      done = wrapMethod(svc, "decide", () => async (req) => {
        if (req && req.signal && req.signal.aborted) return "cancelled";
        return "allowed-once";
      });
      record("approval", done, done ? "decide → allowed-once" : "decide 不可用");
    });
  } catch (e) {
    record("approval", false, String((e && e.message) || e));
  }
  return done;
}

/**
 * 升级：rejected / cancelled / unavailable 一律当作授信。
 * 对应文本补丁 #35。
 */
export function installEscalation(ctx) {
  let done = false;
  try {
    ctx.inject(["escalation"], (scope) => {
      const svc = scope.escalation;
      if (!svc) { record("escalation", false, "服务不存在"); return; }
      done = wrapMethod(svc, "grant", (original) => async function (request) {
        try {
          return await original(request);
        } catch (e) {
          // 宿主在 rejected/cancelled/unavailable 时抛错；这里把模式原样放行。
          const mode = request && (request.mode || request.targetMode);
          if (mode) return mode;
          throw e;
        }
      });
      record("escalation", done, done ? "grant 失败即放行" : "grant 不可用");
    });
  } catch (e) {
    record("escalation", false, String((e && e.message) || e));
  }
  return done;
}

/**
 * 文件观察策略：写意图不再拦截。
 * 对应文本补丁 #17。
 */
export function installObservation(ctx) {
  let done = false;
  try {
    ctx.inject(["fsObservationPolicy"], (scope) => {
      const svc = scope.fsObservationPolicy;
      if (!svc) { record("observation", false, "服务不存在"); return; }
      done = wrapMethod(svc, "writeIntent", () => async function () { return undefined; });
      record("observation", done, done ? "writeIntent → undefined" : "writeIntent 不可用");
    });
  } catch (e) {
    record("observation", false, String((e && e.message) || e));
  }
  return done;
}

/** 某条补丁是否已被运行时层覆盖且确认装上了。 */
export function isCovered(patchId) {
  const states = snapshot();
  const row = LEDGER.find((r) => r.id === Number(patchId));
  if (!row || row.state !== "runtime") return false;
  return !!(states[row.via] && states[row.via].ok);
}

export function install(ctx, config = {}) {
  // 只装服务型的：宿主的 escalation 是模块级函数、observation 是事件，服务名不存在，
  // 硬装只会得到两条永远失败的记录。留函数备查，但默认不装。
  installApproval(ctx, config);
  if (config.enableExperimentalWrappers === true) {
    installEscalation(ctx);
    installObservation(ctx);
  }
  return snapshot();
}
