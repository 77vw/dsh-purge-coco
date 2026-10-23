/**
 * hooks 策略层（第 5 阶段）
 *
 * 现状：hooks 只「旁路」——deny/ask 一律不生效，只记日志。
 * 这里加一层策略，让用户自己决定：
 *
 *   mode: "bypass"   默认，保持现状：用户 hook 拦不住任何人
 *   mode: "enforce"  用户 hook 的 deny/ask 真正生效
 *
 * 外加逐条例外：overrides: [{ command: "前缀或完全匹配", action: "allow"|"block" }]
 * 即使 enforce，也能给某些脚本开白。
 *
 * 存储：$DSH_HOME/dsh-coco/hooks-policy.json
 */
import fs from "node:fs";
import path from "node:path";

const FILE = "hooks-policy.json";
const DEFAULT = { mode: "bypass", overrides: [] };

export function policyPath(dshHome) {
  return path.join(dshHome, "dsh-coco", FILE);
}

export function loadPolicy(dshHome, config = {}) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(policyPath(dshHome), "utf8"));
  } catch { /* 没有就用默认 */ }
  const merged = { ...DEFAULT, ...(saved && typeof saved === "object" ? saved : {}) };
  // 旧配置兜底：hooksDenyBypass=false 等价于 enforce
  if (!saved && config.hooksDenyBypass === false) merged.mode = "enforce";
  if (merged.mode !== "enforce" && merged.mode !== "bypass") merged.mode = "bypass";
  if (!Array.isArray(merged.overrides)) merged.overrides = [];
  return merged;
}

export function savePolicy(dshHome, next) {
  const merged = { ...DEFAULT, ...(next || {}) };
  if (merged.mode !== "enforce" && merged.mode !== "bypass") merged.mode = "bypass";
  if (!Array.isArray(merged.overrides)) merged.overrides = [];
  const fp = policyPath(dshHome);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/** 某条 hook 是否被例外放行。command 匹配用完全相等或前缀。 */
export function overrideFor(policy, command) {
  const cmd = String(command || "");
  for (const row of policy?.overrides || []) {
    const key = String(row?.command || "");
    if (!key) continue;
    if (cmd === key || cmd.startsWith(key)) {
      return row.action === "allow" ? "allow" : row.action === "block" ? "block" : null;
    }
  }
  return null;
}

/**
 * 裁决：给定一条 hook 的拦截结果，返回是否真的拦。
 * bypass → 永不拦；enforce → 白名单放行，其余拦。
 */
export function shouldBlock(policy, suppressed) {
  if (!suppressed) return false;
  if (policy?.mode !== "enforce") return false;
  const decision = overrideFor(policy, suppressed.command);
  if (decision === "allow") return false;
  return true;
}

/** 设置页摘要。 */
export function policyReport(dshHome, config = {}) {
  const p = loadPolicy(dshHome, config);
  return { mode: p.mode, overrides: p.overrides.length, path: policyPath(dshHome) };
}
