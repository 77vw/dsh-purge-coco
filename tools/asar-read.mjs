// 只读 asar 读取器：不落盘、不解包，按需取出单个文件内容。
// 用于 dry-run / 命中率统计，绝不写宿主文件。
import fs from "node:fs";

const U32 = (b, o) => b.readUInt32LE(o);

/** 打开 asar，返回 { header, dataStart, read(path), list() } */
export function openAsar(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  const headerSize = U32(head, 4);
  const hb = Buffer.alloc(headerSize);
  fs.readSync(fd, hb, 0, headerSize, 8);
  const jsonLen = U32(hb, 4);
  const header = JSON.parse(hb.subarray(8, 8 + jsonLen).toString("utf8"));
  const dataStart = 8 + headerSize;

  const lookup = (p) => {
    const parts = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
    let node = header;
    for (let i = 0; i < parts.length; i += 1) {
      const next = node.files && node.files[parts[i]];
      if (!next) return null;
      node = next;
    }
    return node;
  };

  const unpackedDir = `${file}.unpacked`;

  const read = (p) => {
    const node = lookup(p);
    if (!node || node.files || node.link) return null;
    // 放进 app.asar.unpacked 的文件在头部没有 offset，直接从磁盘读
    if (node.unpacked) {
      try { return fs.readFileSync(`${unpackedDir}/${p}`); } catch { return null; }
    }
    const off = dataStart + Number(node.offset);
    const size = Number(node.size);
    if (!Number.isFinite(off) || !Number.isFinite(size)) return null;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, off);
    return buf;
  };

  const list = () => {
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.files) walk(child, p);
        else out.push({ path: p, size: Number(child.size), offset: child.offset });
      }
    };
    walk(header, "");
    return out;
  };

  return { header, dataStart, read, list, lookup, close: () => fs.closeSync(fd) };
}
