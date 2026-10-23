/**
 * 迁移台账：哪些文本补丁已经被运行时层覆盖。
 *
 * state 取值：
 *   runtime  已由运行时层覆盖（文本补丁仍在，作为兜底）
 *   planned  计划迁移
 *   file     只能在文件层处理，不迁移
 *
 * 只有状态为 runtime 且运行时层报告 ok 的补丁，才可以标 supersededBy 退役。
 */
export const LEDGER = [
  { id: 9,  name: "APPROVAL_AUTO_GRANT",      state: "runtime", via: "approval" },
  { id: 10, name: "APPROVAL_CONFIG_DEFAULT_NEVER", state: "runtime", via: "approval" },
  // 下面两条经核查不可代理：宿主没有名为 escalation / fsObservationPolicy 的服务。
  //   · 升级逻辑是 dsh-sandbox 里的模块级函数
  //   · 文件观察是 cordis 事件（ctx.on("fs/write-intent")），不是服务实例
  { id: 35, name: "ESCALATION_NEVER_REJECT",  state: "file", via: "" },
  { id: 17, name: "FS_OBSERVATION_INTENT_FREE", state: "file", via: "" },
  // 下面这些是模块级函数或提示文本，不是服务实例，运行时代理拦不到 —— 老实归为文件层。
  { id: 5,  name: "APPROVAL_NEVER_SENTENCE",  state: "file", via: "" },
  { id: 13, name: "ESCALATION_WIDENING_EXEMPT", state: "file", via: "" },
  { id: 14, name: "ESCALATION_GRANT_UNCONDITIONAL", state: "file", via: "" },
  { id: 34, name: "SANDBOX_HINT_NEUTRAL",      state: "file", via: "" },
  { id: 51, name: "FRESH_SESSION_FULL_ACCESS", state: "file", via: "" },
  { id: 61, name: "OFFICIAL_SANDBOX_POLICY_NEUTRAL", state: "file", via: "" },
  { id: 6,  name: "SANDBOX_DENY_FILE_WRITE",   state: "file", via: "" },
  { id: 15, name: "SANDBOX_CONFINE_PASSTHROUGH", state: "file", via: "" },
  { id: 16, name: "FS_FENCE_DISABLED",         state: "file", via: "" },
  { id: 7,  name: "SANDBOX_MODE_DEFAULT",      state: "file", via: "" },
];

export function ledgerReport(runtimeStates = {}) {
  return LEDGER.map((row) => ({
    ...row,
    installed: row.state === "runtime" ? !!(runtimeStates[row.via] && runtimeStates[row.via].ok) : null,
  }));
}
