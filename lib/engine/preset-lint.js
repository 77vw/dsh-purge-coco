import fs from "node:fs";
import path from "node:path";

/**
 * [dsh-coco] 预设契约检查。
 *
 * 宿主升级会删字段，预设不会自己变——结果是整个模式"加载失败"，用户在卡片上只看到
 * 一坨报错。这里在设置页提前把已知的废弃字段扫出来，不用等挂载失败。
 *
 * 已知契约变更：
 *   · dsh-tool-subagent 0.2.x：移除 persona / toolFilter，改用 agentPreset + allowedAgentPresets
 *   · dsh-persona 0.1.3+    ：旧 text 字段拆成 prefix / suffix
 *
 * 只做行扫描，不引 YAML 依赖（插件无运行时依赖）。
 */
const RULES = [
  {
    name: /'@deepseek-ai\/dsh-tool-subagent'/,
    keys: ["toolFilter", "persona"],
    hint: "改用 agentPreset + allowedAgentPresets（两者必须同时出现），或在 Agent Preset 里配工具与人格",
  },
  {
    name: /'@deepseek-ai\/dsh-persona'/,
    keys: ["text"],
    hint: "改用 prefix / suffix；text 会导致预设挂载失败",
  },
];

export function scanPresetHealth(dshHome) {
  const issues = [];
  if (!dshHome) return issues;
  const root = path.join(dshHome, ".agent-presets");
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return issues;
  }
  for (const preset of dirs) {
    const fp = path.join(root, preset, "agent.cordis.yml");
    let text = "";
    try { text = fs.readFileSync(fp, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const rule = RULES.find((r) => r.name.test(lines[i]));
      if (!rule) continue;
      for (let j = i + 1; j < lines.length && j < i + 60; j += 1) {
        if (/^\s*-\s+id:/.test(lines[j])) break;
        const hit = lines[j].match(/^(\s*)([A-Za-z_][\w]*)\s*:/);
        if (!hit) continue;
        if (!rule.keys.includes(hit[2])) continue;
        issues.push({
          preset,
          file: fp,
          line: j + 1,
          key: hit[2],
          message: `tool/persona 行不再接受 ${hit[2]}：${rule.hint}`,
        });
      }
    }
  }
  return issues;
}
