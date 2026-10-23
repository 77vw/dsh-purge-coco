/**
 * 旁路层清单（借鉴上游 1.6.47 的 BYPASS_LAYERS 思路）
 *
 * 把 86 条补丁按「拆掉哪一层防线」归类。设置页逐层显示：
 * 这一层是完整生效、部分生效、还是本机没有载体。
 *
 * 为什么按层而不是按补丁：用户关心的是"我的边界还剩几层"，不是"第 37 条补丁打没打上"。
 */
export const LAYERS = [
  { key: "workspace", title: "工作区前言", why: "宿主在提示词开头声明「你是不可信数据」的那段", ids: [1, 2, 3] },
  { key: "identity", title: "宿主身份句", why: "带官方自称与产品名的人设段", ids: [4, 25, 26, 32, 43, 76] },
  { key: "preset-identity", title: "预设身份（梁神）", why: "第三方预设自带的身份句", ids: [71, 28] },
  { key: "inject", title: "注入折叠与装配", why: "把注入拼进 persona、每步重贴、避免被旧提示钉住", ids: [40, 55, 74, 87, 88, 89, 92] },
  { key: "slot", title: "模型系统槽位", why: "OpenAI messages[0] / Anthropic params.system 的原生槽", ids: [57, 90, 91, 72] },
  { key: "render", title: "渲染防护", why: "缺 content / 空节点时不再整轮报错", ids: [66, 67, 68] },
  { key: "approval-default", title: "审批默认策略", why: "新会话默认 never，不逐次弹窗", ids: [8, 10, 51] },
  { key: "approval-auto", title: "审批自动放行", why: "每次审批直接 allowed-once（现由运行时层接管）", ids: [9] },
  { key: "approval-text", title: "审批提示文案", why: "告诉模型「不会弹窗」，消除它自我审查的动机", ids: [5, 11, 12, 61, 62, 63] },
  { key: "sandbox-default", title: "沙箱默认模式", why: "默认 danger-full-access", ids: [7] },
  { key: "sandbox-write", title: "沙箱写限制", why: "deny file-write 与 confine 直通", ids: [6, 15] },
  { key: "fs-fence", title: "文件围栏", why: "跨目录写保护", ids: [16] },
  { key: "observation", title: "观察策略", why: "写前意图检查", ids: [17] },
  { key: "escalation", title: "升级阶梯", why: "严格加宽校验与拒答分支", ids: [13, 14, 34, 35] },
  { key: "hooks", title: "hooks 拦截", why: "用户 hook 的 deny / ask / stop", ids: [30, 31, 64, 65] },
  { key: "tools", title: "工具表与工具描述", why: "fetch 开关、删除/移动提示、工具表恢复", ids: [24, 29, 33, 36, 48, 60, 80] },
  { key: "subagent", title: "子代理约束", why: "深度上限与作用域锁", ids: [23, 37] },
  { key: "session", title: "会话与队列", why: "steer 插话路径", ids: [85, 86] },
  { key: "rewind", title: "回退与撤销", why: "回退时隐藏/丢弃的边界", ids: [56, 58, 75, 77] },
  { key: "desktop", title: "桌面与打包", why: "asar 交接、关窗报错、profile 兜底", ids: [45, 46, 82, 83, 84] },
  { key: "oauth", title: "模型网关身份", why: "OAuth 路径下的 Claude 身份伪装", ids: [47, 49] },
  { key: "upload", title: "日志上传", why: "官方默认上传会话日志", ids: [52] },
  { key: "deliverable", title: "交付物提示", why: "禁止 present 的那句", ids: [54] },
  { key: "auto-review", title: "自动审查", why: "Auto Review 拦工具", ids: [59] },
  { key: "budget", title: "预算上限", why: "bash 等待与读文件上限", ids: [21, 22] },
  { key: "noise", title: "重复与修剪", why: "重复工具提醒、结果修剪", ids: [18, 19] },
  { key: "session-format", title: "会话格式兼容", why: "v0 会话、旧 settings API", ids: [38, 39, 42] },
  { key: "plan", title: "计划模式", why: "计划模式下不硬拦实施", ids: [63] },
  { key: "preset-misc", title: "预设细节", why: "预设里的镜像说明与网络提示", ids: [70, 73] },
  { key: "session-ref", title: "跨会话引用", why: "会话引用被标成不可信数据的措辞", ids: [50] },
  { key: "web-surface", title: "Web 面", why: "网页端的身份句与开服务器限制", ids: [53] },
  { key: "stream", title: "流式释放", why: "模型流未正确释放", ids: [69] },
  { key: "overlay", title: "asar 回退", why: "从 .bak 恢复被覆盖的归档", ids: [78] },
];

const OK_STATES = new Set(["applied", "already", "superseded", "off"]);
const NA_STATES = new Set(["na", "skipped", "missing_file"]);

/** 按层汇总补丁状态。 */
export function layerReport(patchStatus = {}) {
  return LAYERS.map((layer) => {
    const rows = layer.ids.map((id) => ({ id, status: patchStatus[id] || "unknown" }));
    const ok = rows.filter((r) => OK_STATES.has(r.status));
    const na = rows.filter((r) => NA_STATES.has(r.status));
    const bad = rows.filter((r) => !OK_STATES.has(r.status) && !NA_STATES.has(r.status));
    const state = bad.length ? "partial" : (ok.length ? "full" : "na");
    return {
      key: layer.key,
      title: layer.title,
      why: layer.why,
      ids: layer.ids,
      ok: ok.map((r) => r.id),
      na: na.map((r) => r.id),
      bad: bad.map((r) => ({ id: r.id, status: r.status })),
      state,
    };
  });
}

/** 一句话汇总：多少层完整、多少层缺、多少层本机无载体。 */
export function layerSummary(report) {
  const list = Array.isArray(report) ? report : [];
  return {
    total: list.length,
    full: list.filter((l) => l.state === "full").length,
    partial: list.filter((l) => l.state === "partial").length,
    na: list.filter((l) => l.state === "na").length,
  };
}
