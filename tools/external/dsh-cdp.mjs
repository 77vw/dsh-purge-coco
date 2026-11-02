// 共享 CDP 客户端。只用 Node 内置 WebSocket/fetch（Node >= 22），不依赖 DSH bundle。
// 全程只跟 127.0.0.1:9223 说话，不激活窗口、不抢焦点。
const PORT = Number(process.env.DSH_CDP_PORT || 9223);
export const BASE = `http://127.0.0.1:${PORT}`;

export async function listTargets({ timeout = 3000 } = {}) {
  const res = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function pageTarget() {
  const list = await listTargets();
  const pages = (list || []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  return pages.find((t) => String(t.url || "").startsWith("dsh-app://")) || pages[0] || null;
}

export async function connect({ timeout = 5000 } = {}) {
  const target = await pageTarget();
  if (!target) {
    const err = new Error("NO_PAGE");
    err.code = 3;
    throw err;
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS_TIMEOUT")), timeout);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS_ERROR")); }, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });

  function send(method, params = {}, { timeout: ms = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method}: timeout ${ms}ms`));
      }, ms);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return { target, send, close() { try { ws.close(); } catch {} } };
}

export async function evaluate(expression, { timeout = 8000 } = {}) {
  const c = await connect();
  try {
    const r = await c.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: false },
      { timeout },
    );
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "exception";
      throw new Error("EVAL_EXCEPTION: " + String(d).split("\n")[0]);
    }
    return r?.result?.value;
  } finally {
    c.close();
  }
}

export function classifyError(err) {
  const msg = String(err?.message || err);
  if (err?.code === 3 || msg.includes("NO_PAGE")) return "NO_PAGE";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|aborted|HTTP 5|timeout/i.test(msg)) return "CDP_DEAD";
  if (msg.startsWith("EVAL_EXCEPTION")) return "EVAL_FAIL";
  return "ERROR";
}

export async function waitForPage({ timeout = 30000, interval = 500, minLen = 200 } = {}) {
  const end = Date.now() + timeout;
  let last = null;
  do {
    try {
      const len = await evaluate("document.body.innerText.length", { timeout: 4000 });
      last = len;
      if (typeof len === "number" && len >= minLen) return { ok: true, len };
    } catch (e) {
      last = classifyError(e);
    }
    await new Promise((r) => setTimeout(r, interval));
  } while (Date.now() < end);
  return { ok: false, last };
}
