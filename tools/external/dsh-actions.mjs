// 页面状态快照 + 往会话发消息的底层实现（供 dsh-say / dsh-continue 共用）。
// 只用 CDP 的 Runtime / Input 域，不激活窗口、不抢前台。

export const SNAPSHOT_EXPR = `(() => {
  const items = Array.from(document.querySelectorAll('[class*="flowItem"]'));
  const errs = Array.from(document.querySelectorAll('[class*="turnErrorMessage"]'));
  let errIdxFromEnd = null, errText = "";
  if (errs.length) {
    const last = errs[errs.length - 1];
    const owner = items.findIndex((it) => it.contains(last));
    errIdxFromEnd = owner >= 0 ? items.length - 1 - owner : 999;
    errText = (last.innerText || "").trim().slice(0, 240);
  }
  const composer = document.querySelector('[contenteditable="true"]');
  const stopBtn = Array.from(document.querySelectorAll("button[aria-label]"))
    .find((b) => /停止|stop/i.test(b.getAttribute("aria-label") || ""));
  const tailItems = items.slice(-2)
    .map((e) => (e.innerText || "").replace(/\\s+/g, " ").trim())
    .filter(Boolean);
  const bodyText = document.body ? (document.body.innerText || "") : "";
  return JSON.stringify({
    bodyLen: bodyText.length,
    flowCount: items.length,
    errIdxFromEnd,
    errText,
    busy: !!stopBtn,
    stopLabel: stopBtn ? stopBtn.getAttribute("aria-label") : null,
    composer: !!composer && composer.offsetParent !== null,
    composerText: composer ? (composer.innerText || "").trim().slice(0, 200) : null,
    tail: tailItems.join(" | ").slice(0, 400),
    title: document.title,
    href: location.href,
  });
})()`;

export async function snapshot(c) {
  const r = await c.send("Runtime.evaluate", {
    expression: SNAPSHOT_EXPR,
    returnByValue: true,
    awaitPromise: true,
  }, { timeout: 8000 });
  if (r?.exceptionDetails) throw new Error("SNAPSHOT_FAIL");
  const v = r?.result?.value;
  return typeof v === "string" ? JSON.parse(v) : null;
}

export async function composerInfo(c) {
  const r = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[contenteditable="true"]');
      if (!el || el.offsetParent === null) return JSON.stringify({ ok: false, why: "no-composer" });
      el.focus();
      const rect = el.getBoundingClientRect();
      const stop = Array.from(document.querySelectorAll("button[aria-label]"))
        .find((b) => /停止|stop/i.test(b.getAttribute("aria-label") || ""));
      return JSON.stringify({
        ok: true,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        before: (el.innerText || "").trim().length,
        busy: !!stop,
      });
    })()`,
    returnByValue: true,
  }, { timeout: 8000 });
  const v = r?.result?.value;
  return typeof v === "string" ? JSON.parse(v) : { ok: false, why: "eval" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 返回 { ok, sent, verified, cleared, busy, reason }
export async function sendMessage(c, text, { force = false, verifyMs = 2500 } = {}) {
  const info = await composerInfo(c);
  if (!info?.ok) return { ok: false, sent: false, reason: info?.why || "no-composer" };
  if (info.busy && !force) return { ok: false, sent: false, reason: "busy" };
  if (info.before > 0 && !force) return { ok: false, sent: false, reason: "draft-exists" };

  await c.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: info.x, y: info.y, button: "left", clickCount: 1,
  });
  await c.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: info.x, y: info.y, button: "left", clickCount: 1,
  });
  await sleep(60);
  await c.send("Input.insertText", { text });
  await sleep(120);

  const typed = await c.send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector('[contenteditable="true"]'); return el ? (el.innerText || "").trim().length : -1; })()`,
    returnByValue: true,
  }, { timeout: 5000 });
  if (!(typed?.result?.value > 0)) {
    return { ok: false, sent: false, reason: "insert-failed" };
  }

  await c.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await c.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(500);

  // 有些版本 contenteditable 的 Enter 被拦截，退回到点发送按钮
  let cleared = await c.send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector('[contenteditable="true"]'); return el ? (el.innerText || "").trim().length === 0 : false; })()`,
    returnByValue: true,
  }, { timeout: 5000 }).then((r) => r?.result?.value === true).catch(() => false);

  if (!cleared) {
    await c.send("Runtime.evaluate", {
      expression: `(() => { const b = document.querySelector('button[aria-label="发送消息"]'); if (b) { b.click(); return true; } return false; })()`,
      returnByValue: true,
    }, { timeout: 5000 }).catch(() => {});
    await sleep(600);
    cleared = await c.send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector('[contenteditable="true"]'); return el ? (el.innerText || "").trim().length === 0 : false; })()`,
      returnByValue: true,
    }, { timeout: 5000 }).then((r) => r?.result?.value === true).catch(() => false);
  }

  // 再等一会儿看会话是否真的动起来（最后一条消息变化 / 进入生成态）
  const before = await snapshot(c).catch(() => null);
  await sleep(verifyMs);
  const after = await snapshot(c).catch(() => null);
  const moved = !!(before && after && (after.busy || after.flowCount !== before.flowCount || after.tail !== before.tail));

  return {
    ok: true,
    sent: true,
    cleared,
    verified: moved,
    busy: after?.busy ?? null,
    flowCount: after?.flowCount ?? null,
    reason: cleared ? "enter" : "sent-maybe",
  };
}
