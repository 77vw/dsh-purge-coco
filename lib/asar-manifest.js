// asar 换目录的落账与校验：插件和 CLI（tools/safe-apply.mjs）共用同一份 manifest，
// 保证「点 Apply」和「命令行 apply」留下的现场完全一致，--recover 认得出。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** appDir = <bundle>/Contents/Resources/app → 状态目录是同级 .dsh-coco */
export function stateDirFor(appDir) {
  return path.join(path.dirname(appDir), ".dsh-coco");
}

export function manifestPathFor(appDir) {
  return path.join(stateDirFor(appDir), "manifest.json");
}

export function asarBakPath(asar) {
  return `${asar}.dsh-coco.bak`;
}

export function sha256File(fp) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(fp, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n += 1;
    }
  };
  try { walk(dir); } catch { return -1; }
  return n;
}

export function writeSwapManifest(appDir, asarPath, extra = {}) {
  const st = fs.statSync(asarPath);
  const data = {
    tool: "dsh-coco",
    format: 1,
    app: path.resolve(appDir, "..", "..", ".."),
    asar: {
      path: asarPath,
      sha256: sha256File(asarPath),
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
    },
    extracted: { files: countFiles(appDir), ...extra },
    createdAt: new Date().toISOString(),
  };
  const dir = stateDirFor(appDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${path.join(dir, "manifest.json")}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, path.join(dir, "manifest.json"));
  return data;
}

export function readSwapManifest(appDir) {
  try { return JSON.parse(fs.readFileSync(manifestPathFor(appDir), "utf8")); } catch { return null; }
}

export function clearSwapManifest(appDir) {
  try { fs.rmSync(stateDirFor(appDir), { recursive: true, force: true }); } catch { /* ignore */ }
}
