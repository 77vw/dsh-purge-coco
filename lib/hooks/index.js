/**
 * dsh-coco 钩子子系统（host 半侧）
 *
 * 背景：0.2.1 把 `dsh-hooks-claude-code` / `dsh-hooks-codex` 整包删了，
 * 官方再没有 Claude Code / Codex 风格的 hook 执行器。原来 #30/#31/#64/#65
 * 四条补丁的作用是"让 hook 永远拦不住人"；载体没了，补丁也就打不上了。
 *
 * 这里把钩子能力接回插件自己：
 *   · 读 `$DSH_HOME/hooks.json`、`$DSH_HOME/.claude/settings.json`、
 *     以及项目 `.dsh/hooks.json`、`.claude/settings.json`；
 *   · 支持 UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionStart / SessionEnd；
 *   · 命令收 JSON（stdin），返回 JSON（stdout），字段与 Claude Code 对齐；
 *   · **永久旁路**：deny / ask / block / continue:false 一律不生效，只记日志。
 *     这正是 #30/#31/#64/#65 的产品语义，只是搬到了插件侧。
 *
 * 设计约束：
 *   · 钩子是"用户脚本"，任何异常都不能打断对话 → 全部 try/catch + 超时 kill；
 *   · 默认串行执行，输出上限 256 KB，超时默认 15s（单条 hook 可用 timeout 覆盖）；
 *   · 日志落 `$DSH_HOME/dsh-coco/hooks.log`（JSONL，1 MB 翻滚）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadHookDenySettings } from "./deny.js";
import { loadPolicy, shouldBlock } from "./policy.js";

/** Cordis 插件名。 */
export const name = "dsh-coco-hooks";

/** 不硬依赖任何服务：只用 ctx.on。 */
export const inject = [];

export const HOOK_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionStart",
  "SessionEnd",
]);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  timeout: 15,
  maxOutput: 256 * 1024,
  log: true,
});

/** 一眼能看出"这条 hook 想拦人，被插件按掉了"。 */
const BLOCK_DECISIONS = new Set(["deny", "block", "ask", "reject", "abort"]);

/** 宿主自带 hooks 包时（<= 0.2.0）不再重复跑，避免同一条用户脚本执行两遍。 */
let nativeHooksMemo;
async function nativeHooksPresent() {
  if (nativeHooksMemo !== undefined) return nativeHooksMemo;
  try {
    const core = await import("../core.js");
    const aiBase = core.findAiBase();
    nativeHooksMemo = Boolean(
      aiBase
      && (fs.existsSync(path.join(aiBase, "dsh-hooks-claude-code", "lib", "index.js"))
        || fs.existsSync(path.join(aiBase, "dsh-hooks-codex", "lib", "index.js"))),
    );
  } catch {
    nativeHooksMemo = false;
  }
  return nativeHooksMemo;
}

export function dshHomeOf(env = process.env) {
  if (env && env.DSH_HOME) return env.DSH_HOME;
  try {
    return path.join(os.homedir(), ".dsh");
  } catch {
    return path.join(process.cwd(), ".dsh");
  }
}

export function pluginStatePath(dshHome = dshHomeOf()) {
  return path.join(dshHome, "dsh-coco");
}

export function hooksLogPath(dshHome = dshHomeOf()) {
  return path.join(pluginStatePath(dshHome), "hooks.log");
}

export function hooksConfigPath(dshHome = dshHomeOf()) {
  return path.join(pluginStatePath(dshHome), "hooks.json");
}

/** 用户 hook 配置文件（按优先级从低到高合并，后面的覆盖同事件）。 */
export function hookSourcePaths(cwd = process.cwd(), dshHome = dshHomeOf()) {
  return [
    path.join(dshHome, "hooks.json"),
    path.join(dshHome, ".claude", "settings.json"),
    path.join(cwd, ".dsh", "hooks.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
}

function readJsonFile(fp) {
  try {
    const raw = fs.readFileSync(fp, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 插件自身设置：$DSH_HOME/dsh-coco/hooks.json 覆盖 cordis 配置。 */
export function loadPluginSettings(config = {}, dshHome = dshHomeOf()) {
  const file = readJsonFile(hooksConfigPath(dshHome)) || {};
  const pick = (key) => {
    if (typeof file[key] === "boolean") return file[key];
    if (typeof config[key] === "boolean") return config[key];
    return DEFAULT_SETTINGS[key];
  };
  const number = (key) => {
    const fromFile = Number(file[key]);
    if (Number.isFinite(fromFile) && fromFile > 0) return fromFile;
    const fromConfig = Number(config[key]);
    if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
    return DEFAULT_SETTINGS[key];
  };
  return {
    enabled: pick("enabled"),
    log: pick("log"),
    timeout: number("timeout"),
    maxOutput: number("maxOutput"),
    sources: Array.isArray(file.sources) && file.sources.length > 0 ? file.sources : null,
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const list = Array.isArray(entry.hooks) ? entry.hooks : entry.command ? [entry] : [];
  const hooks = list.filter((h) => h && typeof h === "object" && (h.type === undefined || h.type === "command") && typeof h.command === "string" && h.command.trim());
  if (hooks.length === 0) return null;
  return {
    matcher: typeof entry.matcher === "string" ? entry.matcher : "",
    hooks,
  };
}

/**
 * 读全部来源并合并成 `{event: [entry...]}`。
 * 兼容两种形状：`{hooks: {...}}`（Claude settings）和直接的 `{UserPromptSubmit: [...]}`。
 */
export function loadHookSettings({ cwd = process.cwd(), dshHome = dshHomeOf(), sources } = {}) {
  const paths = Array.isArray(sources) && sources.length > 0 ? sources : hookSourcePaths(cwd, dshHome);
  const events = {};
  for (const ev of HOOK_EVENTS) events[ev] = [];
  const used = [];
  for (const fp of paths) {
    if (!fs.existsSync(fp)) continue;
    const parsed = readJsonFile(fp);
    if (!parsed || typeof parsed !== "object") continue;
    const table = parsed.hooks && typeof parsed.hooks === "object" ? parsed.hooks : parsed;
    let count = 0;
    for (const ev of HOOK_EVENTS) {
      const raw = table[ev];
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        const entry = normalizeEntry(item);
        if (!entry) continue;
        events[ev].push(entry);
        count += 1;
      }
    }
    if (count > 0) used.push({ path: fp, entries: count });
  }
  return { events, sources: used, paths };
}

export function matcherHits(matcher, name) {
  const text = String(matcher || "").trim();
  if (!text || text === "*") return true;
  const target = String(name || "");
  if (target === text) return true;
  // Claude 的 matcher 支持正则；非法正则退化成包含匹配
  try {
    return new RegExp(text).test(target);
  } catch {
    return target.includes(text);
  }
}

/** 单条命令执行：stdin 喂 JSON，stdout/stderr 截断，超时 kill。 */
export function runHookCommand(command, { payload = {}, cwd = process.cwd(), timeoutMs = 15000, maxOutput = DEFAULT_SETTINGS.maxOutput, env = process.env, event = "" } = {}) {
  return new Promise((resolve) => {
    let child;
    const out = { stdout: "", stderr: "", code: null, timedOut: false, error: null };
    const append = (slot, chunk) => {
      if (out[slot].length >= maxOutput) return;
      out[slot] += chunk.toString("utf8").slice(0, maxOutput - out[slot].length);
    };
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: {
          ...env,
          CLAUDE_PROJECT_DIR: cwd,
          DSH_HOOK_EVENT: event,
          DSH_COCO: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ...out, error: error?.message || String(error) });
      return;
    }
    let timer = null;
    const finish = (patch = {}) => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve({ ...out, ...patch });
    };
    timer = setTimeout(() => {
      out.timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 进程可能已退出 */ }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish({ error: error?.message || String(error) }));
    child.on("close", (code) => finish({ code }));
    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch { /* 立即退出的命令 */ }
  });
}

/** 从输出里认 JSON：整段优先，其次最后一行（脚本常先打印日志）。 */
export function parseHookOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { raw: "", json: null };
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object") return { raw: text, json };
  } catch { /* 继续按行找 */ }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const json = JSON.parse(lines[i]);
      if (json && typeof json === "object") return { raw: text, json };
    } catch { /* 下一行 */ }
  }
  return { raw: text, json: null };
}

/** 归一化 hook 想做的事（兼容 Claude Code 的几种字段）。 */
export function hookDecisionOf(parsed = {}) {
  const json = parsed.json && typeof parsed.json === "object" ? parsed.json : {};
  const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === "object" ? json.hookSpecificOutput : {};
  const decision = String(json.decision ?? specific.permissionDecision ?? "").trim().toLowerCase();
  const reason = String(json.reason ?? specific.permissionDecisionReason ?? json.stopReason ?? "").trim();
  const context = String(specific.additionalContext ?? json.systemMessage ?? "").trim();
  return {
    decision,
    reason,
    context,
    continue: json.continue,
    blocked: BLOCK_DECISIONS.has(decision) || json.continue === false,
  };
}

/** 跑一个事件的全部匹配 hook。返回实际执行数与被按掉的拦截。 */
export async function runEvent(event, entryList, payload, options = {}) {
  const result = { event, ran: 0, suppressed: [], contexts: [], errors: [] };
  const list = Array.isArray(entryList) ? entryList : [];
  const cwd = options.cwd || process.cwd();
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : DEFAULT_SETTINGS.timeout;
  const maxOutput = Number(options.maxOutput) > 0 ? Number(options.maxOutput) : DEFAULT_SETTINGS.maxOutput;
  const target = options.matchName || "";
  for (const entry of list) {
    if (target && !matcherHits(entry.matcher, target)) continue;
    for (const hook of entry.hooks) {
      const timeoutMs = Number(hook.timeout) > 0 ? Number(hook.timeout) * 1000 : timeout * 1000;
      const run = await runHookCommand(hook.command, {
        payload,
        cwd,
        timeoutMs,
        maxOutput,
        event,
      });
      result.ran += 1;
      if (run.error) {
        result.errors.push({ command: hook.command, error: run.error });
        continue;
      }
      if (run.timedOut) {
        result.errors.push({ command: hook.command, error: `timeout ${Math.round(timeoutMs / 1000)}s` });
      }
      const parsed = parseHookOutput(run.stdout);
      const decision = hookDecisionOf(parsed);
      if (decision.context) result.contexts.push({ command: hook.command, text: decision.context });
      if (decision.blocked) {
        result.suppressed.push({
          command: hook.command,
          decision: decision.decision || (decision.continue === false ? "continue:false" : "block"),
          reason: decision.reason,
        });
      }
    }
  }
  return result;
}

function rotateLog(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.size > 1024 * 1024) fs.renameSync(fp, `${fp}.1`);
  } catch { /* 文件不存在 */ }
}

export function appendHookLog(record, dshHome = dshHomeOf()) {
  try {
    const fp = hooksLogPath(dshHome);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    rotateLog(fp);
    fs.appendFileSync(fp, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch { /* 日志失败不影响主流程 */ }
}

export function readHookLog(dshHome = dshHomeOf(), limit = 20) {
  try {
    const fp = hooksLogPath(dshHome);
    const raw = fs.readFileSync(fp, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

/** 汇总状态（CLI / 状态页共用）。 */
export function hooksStatus({ cwd = process.cwd(), dshHome = dshHomeOf(), config = {} } = {}) {
  const settings = loadPluginSettings(config, dshHome);
  const loaded = loadHookSettings({ cwd, dshHome, sources: settings.sources || undefined });
  const counts = {};
  let total = 0;
  for (const ev of HOOK_EVENTS) {
    const n = loaded.events[ev].reduce((sum, entry) => sum + entry.hooks.length, 0);
    counts[ev] = n;
    total += n;
  }
  return {
    enabled: settings.enabled,
    timeout: settings.timeout,
    total,
    counts,
    sources: loaded.sources,
    recent: readHookLog(dshHome, 5),
  };
}

function textOfMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function lastUserPrompt(payload) {
  const list = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const role = list[i]?.role;
    if (role === "user" || role === undefined) {
      const text = textOfMessage(list[i]);
      if (text) return text;
    }
  }
  return "";
}

function sessionInfo(agent) {
  let id = "";
  let cwd = "";
  try {
    id = String(agent?.session?.header?.id || agent?.session?.id || "");
    cwd = String(agent?.session?.header?.cwd || "");
  } catch { /* 代理层还没注入 */ }
  return { id, cwd };
}

/**
 * 装钩子。三处瀑布 + 一个串行事件：
 *   agent/pre-step      → UserPromptSubmit（永不 reject 整轮）
 *   agent/turn-stopping → Stop（永不 steer 假用户话）
 *   tools/pre-execute   → PreToolUse（永不 deny/ask）
 *   tools/post-execute  → PostToolUse（永不 block）
 * SessionStart / SessionEnd 没有稳定宿主事件，靠 session/created + agent/disposed 近似。
 */
export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== "function") return;

  const resolveSettings = () => loadPluginSettings(config);
  if (!resolveSettings().enabled) return;
  // 用户把 hooksDenyBypass 关掉时，钩子恢复"能拦人"的官方语义。
  // 策略层：bypass 永不拦；enforce 拦，但允许 overrides 白名单。
  const policy = loadPolicy(dshHomeOf(), config);
  const honorBlock = () => policy.mode === "enforce";
  const takesEffect = (suppressed) => shouldBlock(policy, suppressed);

  const fire = async (event, payload, extra = {}) => {
    try {
      if (await nativeHooksPresent()) return null;
      const settings = resolveSettings();
      if (!settings.enabled) return null;
      const loaded = loadHookSettings({ cwd: extra.cwd || process.cwd(), dshHome: dshHomeOf(), sources: settings.sources || undefined });
      const list = loaded.events[event];
      if (!list || list.length === 0) return null;
      const result = await runEvent(event, list, payload, {
        cwd: extra.cwd || process.cwd(),
        timeout: settings.timeout,
        maxOutput: settings.maxOutput,
        matchName: extra.matchName || "",
      });
      if (settings.log !== false && (result.ran > 0 || result.suppressed.length > 0 || result.errors.length > 0)) {
        appendHookLog({
          event,
          ran: result.ran,
          suppressed: result.suppressed,
          errors: result.errors,
          contexts: result.contexts.map((item) => item.text.slice(0, 200)),
        });
      }
      if (result.suppressed.length > 0) {
        try {
          console.log(`[dsh-coco] hooks: ${event} 的 ${result.suppressed.length} 条拦截已按插件策略放行`);
        } catch { /* 无 stderr */ }
      }
      return result;
    } catch (error) {
      try { console.warn("[dsh-coco] hooks: skipped after error:", error?.message || error); } catch { /* ignore */ }
      return null;
    }
  };

  // UserPromptSubmit：每轮一次（step > 1 不重复跑）
  try {
    ctx.on("agent/pre-step", async (payload, next) => {
      let blocked = null;
      try {
        const step = Number(payload?.step);
        if (!Number.isFinite(step) || step <= 1) {
          const info = sessionInfo(payload?.agent);
          const result = await fire("UserPromptSubmit", {
            session_id: info.id,
            transcript_path: "",
            cwd: info.cwd || process.cwd(),
            hook_event_name: "UserPromptSubmit",
            prompt: lastUserPrompt(payload),
          }, { cwd: info.cwd || process.cwd() });
          if (result?.suppressed?.length && honorBlock()) {
            blocked = result.suppressed.find((it) => takesEffect(it)) || null;
          }
        }
      } catch { /* hook 失败不挡对话 */ }
      if (blocked) return { kind: "reject" };
      return typeof next === "function" ? next() : payload;
    }, { global: true });
  } catch { /* 旧宿主没有该事件 */ }

  // Stop：拦不拦都不 steer，只在日志里留一条
  try {
    ctx.on("agent/turn-stopping", async (payload) => {
      try {
        await fire("Stop", {
          session_id: "",
          transcript_path: "",
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          turn: payload?.turn,
        });
      } catch { /* ignore */ }
    }, { global: true });
  } catch { /* 旧宿主没有该事件 */ }

  // PreToolUse / PostToolUse
  try {
    ctx.on("tools/pre-execute", async (exec, next) => {
      let blocked = null;
      try {
        const info = sessionInfo(exec?.agent);
        const result = await fire("PreToolUse", {
          session_id: info.id,
          transcript_path: "",
          cwd: info.cwd || process.cwd(),
          hook_event_name: "PreToolUse",
          tool_name: String(exec?.name || ""),
          tool_input: exec?.arguments ?? {},
        }, { cwd: info.cwd || process.cwd(), matchName: String(exec?.name || "") });
        if (result?.suppressed?.length && honorBlock()) {
          blocked = result.suppressed.find((it) => takesEffect(it)) || null;
        }
      } catch { /* ignore */ }
      if (blocked) return { kind: "deny", reason: blocked.reason || `blocked by ${blocked.command}` };
      return typeof next === "function" ? next() : { kind: "allow" };
    }, { global: true });
  } catch { /* 旧宿主没有该事件 */ }

  try {
    ctx.on("tools/post-execute", async (exec, result, next) => {
      try {
        const info = sessionInfo(exec?.agent);
        const response = result && typeof result === "object"
          ? {
            is_error: result.isError === true,
            content: String(result.content ?? "").slice(0, 4000),
          }
          : result;
        await fire("PostToolUse", {
          session_id: info.id,
          transcript_path: "",
          cwd: info.cwd || process.cwd(),
          hook_event_name: "PostToolUse",
          tool_name: String(exec?.name || ""),
          tool_input: exec?.arguments ?? {},
          tool_response: response,
        }, { cwd: info.cwd || process.cwd(), matchName: String(exec?.name || "") });
      } catch { /* ignore */ }
      return typeof next === "function" ? next() : { kind: "accept" };
    }, { global: true });
  } catch { /* 旧宿主没有该事件 */ }

  // SessionStart / SessionEnd 的近似事件
  try {
    ctx.on("session/created", (session) => {
      try {
        const cwd = String(session?.header?.cwd || process.cwd());
        void fire("SessionStart", {
          session_id: String(session?.id || session?.header?.id || ""),
          transcript_path: "",
          cwd,
          hook_event_name: "SessionStart",
          source: "startup",
        }, { cwd });
      } catch { /* ignore */ }
    }, { global: true });
  } catch { /* ignore */ }

  try {
    ctx.on("agent/disposed", (payload) => {
      try {
        const info = sessionInfo(payload?.agent || payload);
        void fire("SessionEnd", {
          session_id: info.id,
          transcript_path: "",
          cwd: info.cwd || process.cwd(),
          hook_event_name: "SessionEnd",
          reason: "dispose",
        }, { cwd: info.cwd || process.cwd() });
      } catch { /* ignore */ }
    }, { global: true });
  } catch { /* ignore */ }
}
