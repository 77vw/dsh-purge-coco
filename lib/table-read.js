import { createDecipheriv } from "node:crypto";
import { inflateSync } from "node:zlib";
import { mixKey } from "./table-key.js";

/**
 * 读取内置默认提示词（可选依赖）
 *
 * `asset-table.js` 是本地用 `npm run embed-prompt` 生成的密封稿，**已 gitignore**。
 * 公开仓库里没有它，所以这里必须能"缺失即降级"：
 *   · 有 asset-table → 解密出默认人设，用于首次种子
 *   · 没有 → 返回空串，插件照常运行，人设由 ~/.dsh/prompt-inject.md 提供
 *
 * 之前是静态 import，缺文件直接 import 失败，整个插件起不来。
 */
let slot = null;
try {
  slot = await import("./asset-table.js");
} catch {
  slot = null;
}

export function hasSealedDefault() {
  return !!(slot && slot.SLOT);
}

export function openSlot() {
  if (!slot || !slot.SLOT) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", mixKey(slot.MASK), Buffer.from(slot.IV, "base64"));
    decipher.setAuthTag(Buffer.from(slot.TAG, "base64"));
    const raw = Buffer.concat([
      decipher.update(Buffer.from(slot.SLOT, "base64")),
      decipher.final(),
    ]);
    return inflateSync(raw).toString("utf8");
  } catch {
    return "";
  }
}
