// i18n 对齐：中英文字典的键集合必须一致（阶段 4.3）
// 之前 zh 266 / en 287，存在漏翻与多余键。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");

/** 从源码里截出两个字典对象：const zh = { ... }; const en = { ... }; */
function dictKeys(name) {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) return null;
  let i = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(start, end + 1);
  const keys = new Set();
  for (const m of body.matchAll(/^\s*"([a-zA-Z][\w.]*)"\s*:/gm)) keys.add(m[1]);
  return keys;
}

const zh = dictKeys("zh");
const en = dictKeys("en");
let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

ok("找到中文字典", !!zh && zh.size > 100, zh ? `${zh.size} 键` : "未找到");
ok("找到英文字典", !!en && en.size > 100, en ? `${en.size} 键` : "未找到");

if (zh && en) {
  const onlyZh = [...zh].filter((k) => !en.has(k));
  const onlyEn = [...en].filter((k) => !zh.has(k));
  ok("中文独有键为 0", onlyZh.length === 0, onlyZh.slice(0, 8).join(" "));
  ok("英文独有键为 0", onlyEn.length === 0, onlyEn.slice(0, 8).join(" "));
}

process.exit(failed ? 1 : 0);
