/**
 * 锚点覆盖（阶段 2 · 借鉴上游 1.6.47 的 reanchor）
 *
 * 宿主升级后，某些补丁的匹配串会失效（例如 #71 依赖的梁神预设）。
 * 与其干瞪眼，不如允许把"确认过的新锚点"钉在本地：
 *
 *   { "71": { find: "旧串", replace: "新串", note: "0.2.2 改了缩进" } }
 *
 * 覆盖只影响这一台机器，删文件即恢复出厂。apply 时优先用覆盖，失败再退回原规则。
 */
import fs from "node:fs";
import path from "node:path";

const FILE = "anchor-overrides.json";

export function overridesPath(home) {
  return path.join(home, "dsh-coco", FILE);
}

export function loadOverrides(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(overridesPath(home), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveOverrides(home, all) {
  const fp = overridesPath(home);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(all || {}, null, 2), "utf8");
  return all || {};
}

export function putOverride(home, id, { find, replace, note = "" }) {
  const key = String(id);
  if (!find || typeof replace !== "string") throw new Error("find 与 replace 都必须提供");
  const all = loadOverrides(home);
  all[key] = { find: String(find), replace: String(replace), note: String(note || ""), at: Date.now() };
  return saveOverrides(home, all);
}

export function removeOverride(home, id) {
  const all = loadOverrides(home);
  delete all[String(id)];
  return saveOverrides(home, all);
}

export function getOverride(home, id) {
  const row = loadOverrides(home)[String(id)];
  return row && row.find ? row : null;
}
