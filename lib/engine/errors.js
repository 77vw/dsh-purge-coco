/**
 * 错误码（阶段 1.2）
 *
 * 目的：对外错误不再是散装字符串。每个错误有稳定编号，页面能显示，日志能检索。
 * 编号分段：
 *   E0xx 宿主与安装      E1xx 补丁      E2xx 注入链
 *   E3xx 运行时层        E4xx hooks    E5xx 网络与路由
 */
export const CODES = Object.freeze({
  E001: "找不到宿主安装目录",
  E002: "宿主目录不可写",
  E003: "宿主版本无法识别",
  E004: "桌面端 asar 仍处于封装状态",
  E101: "补丁目标文件缺失",
  E102: "补丁模式未匹配（宿主可能改版）",
  E103: "补丁写入失败",
  E104: "回滚失败",
  E105: "备份目录不可用",
  E201: "注入文本为空",
  E202: "装配段重复",
  E203: "档位配置非法",
  E301: "运行时层服务不存在",
  E302: "运行时层包装失败",
  E401: "hooks 策略文件损坏",
  E402: "hook 执行超时",
  E501: "路由未鉴权",
  E502: "请求体非法",
  E503: "内部调用超时",
});

export class CocoError extends Error {
  constructor(code, detail = "", cause = null) {
    const message = CODES[code] || "未知错误";
    super(detail ? `${code} ${message}: ${detail}` : `${code} ${message}`);
    this.name = "CocoError";
    this.code = code;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
  toJSON() {
    return { code: this.code, message: CODES[this.code] || "未知错误", detail: this.detail };
  }
}

/** 把任意异常折成对外结构。已知错误带码，未知的归到传入的兜底码。 */
export function toWire(err, fallback = "E503") {
  if (err instanceof CocoError) return err.toJSON();
  const msg = String((err && err.message) || err || "");
  const code = codeFromMessage(msg) || fallback;
  return { code, message: CODES[code] || "未知错误", detail: msg };
}

/** 从历史字符串里认出常见失败，给出对应码（兼容旧调用点）。 */
export function codeFromMessage(msg) {
  const m = String(msg || "");
  if (/toolFilter is no longer supported|no longer supported/.test(m)) return "E102";
  if (/pattern_not_found|匹配失败/.test(m)) return "E102";
  if (/ENOENT|not found|不存在/.test(m)) return "E101";
  if (/EACCES|EPERM|不可写/.test(m)) return "E002";
  if (/timeout|timed out|超时/i.test(m)) return "E503";
  if (/hooks-policy|hooks\.json/.test(m)) return "E401";
  return "";
}
