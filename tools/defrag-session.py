#!/usr/bin/env python3
"""
会话病史清理：把 assistant/message 里 reasoning 文本中的祈使碎片行删掉。

为什么需要它：
  reasoning 在宿主侧没有 signature，发给模型时会被降级成 text（见
  pi-ai anthropic-messages.js convertMessages）。也就是说上一轮的「做。」是
  被当作"我说过的正文"原样喂回去的。一条会话被 1,733 个带碎片的块污染之后，
  历史本身就在教模型继续复读 —— 只装流层拦截救不了已经感染的会话。

做法：
  · 只动 assistant/message 的 reasoning block 和 compaction/summary 的文本
  · 删掉整行都是碎片的行（做。/好。/写。/继续。这一类）
  · 折叠 3 个以上连续空行
  · seq / time / usage 一个字节都不改，不动任何 tool call 与正文
  · 先备份，改完校验事件数与 seq 连续性，再原子替换

用法：
  python3 tools/defrag-session.py <session.v4.jsonl.zstd> --dry-run
  python3 tools/defrag-session.py <session.v4.jsonl.zstd> --apply
"""
import json
import os
import re
import subprocess
import sys
import time

LEAD = re.compile(r"^[\s>*•·\-–—]+")
TAIL = re.compile(r"[。.！!？?、,，;；:：…\s]+$")
FILLER = set("好做写等分对行停继续结束收尾完嗯")


def is_filler(line: str) -> bool:
    t = TAIL.sub("", LEAD.sub("", line))
    if not t or len(t) > 4:
        return False
    return all(ch in FILLER for ch in t)


def clean_text(text: str):
    """返回 (新文本, 删掉的碎片行数)"""
    if not text:
        return text, 0
    kept = []
    dropped = 0
    for line in text.split("\n"):
        if is_filler(line):
            dropped += 1
            continue
        kept.append(line)
    out = "\n".join(kept)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out, dropped


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    path = sys.argv[1]
    dry = "--apply" not in sys.argv

    if not os.path.isfile(path):
        print("no such file:", path)
        sys.exit(1)

    print(f"{'DRY-RUN' if dry else 'APPLY'} {path}")
    print(f"size {os.path.getsize(path):,} bytes")

    tmp_jsonl = path + ".defrag.tmp.jsonl"
    stats = {"lines": 0, "blocks": 0, "blocks_changed": 0, "lines_dropped": 0,
             "chars_before": 0, "chars_after": 0, "summaries": 0}
    last_seq = -1
    seq_gaps = 0

    dec = subprocess.Popen(["zstd", "-dc", path], stdout=subprocess.PIPE)
    out = open(tmp_jsonl, "w", encoding="utf-8") if not dry else None
    try:
        for raw in dec.stdout:
            stats["lines"] += 1
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                if out:
                    out.write(raw.decode("utf-8", "surrogateescape"))
                continue

            seq = e.get("seq")
            if isinstance(seq, int):
                if last_seq >= 0 and seq != last_seq + 1:
                    seq_gaps += 1
                last_seq = seq

            changed = False
            t = e.get("type")
            data = e.get("data") or {}

            if t == "assistant/message":
                content = (data.get("message") or {}).get("content")
                if isinstance(content, list):
                    for blk in content:
                        if not isinstance(blk, dict) or blk.get("type") != "reasoning":
                            continue
                        stats["blocks"] += 1
                        before = blk.get("text") or ""
                        after, dropped = clean_text(before)
                        if dropped:
                            stats["lines_dropped"] += dropped
                            stats["chars_before"] += len(before)
                            stats["chars_after"] += len(after)
                            stats["blocks_changed"] += 1
                            blk["text"] = after
                            changed = True
                        else:
                            stats["chars_before"] += len(before)
                            stats["chars_after"] += len(before)

            elif t == "compaction/summary":
                for key in ("summary", "rawOutput"):
                    before = data.get(key)
                    if isinstance(before, str) and before:
                        after, dropped = clean_text(before)
                        if dropped:
                            stats["lines_dropped"] += dropped
                            stats["summaries"] += 1
                            data[key] = after
                            changed = True

            if out:
                out.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")
                if changed:
                    out.flush()
        dec.wait()
    finally:
        if out:
            out.close()

    print(f"events            {stats['lines']:,}")
    print(f"last seq          {last_seq}  (gaps: {seq_gaps})")
    print(f"reasoning blocks  {stats['blocks']:,}  (changed {stats['blocks_changed']:,})")
    print(f"summaries changed {stats['summaries']}")
    print(f"filler lines cut  {stats['lines_dropped']:,}")
    if stats["chars_before"]:
        pct = (1 - stats["chars_after"] / stats["chars_before"]) * 100
        print(f"reasoning chars   {stats['chars_before']:,} -> {stats['chars_after']:,}  (-{pct:.1f}%)")

    if dry:
        if os.path.exists(tmp_jsonl):
            os.unlink(tmp_jsonl)
        print("\n没有写入。加 --apply 执行。")
        return

    if seq_gaps:
        print("ABORT: seq 出现缺口，不替换原文件")
        os.unlink(tmp_jsonl)
        sys.exit(1)

    tmp_zst = path + ".defrag.tmp.zst"
    subprocess.run(["zstd", "-19", "-q", "-f", tmp_jsonl, "-o", tmp_zst], check=True)
    print(f"new size          {os.path.getsize(tmp_zst):,} bytes")

    # 校验：新文件能解压、事件数与旧的一致
    check = subprocess.run(["zstd", "-dc", tmp_zst], capture_output=True)
    if check.returncode != 0:
        print("ABORT: 新压缩包解不开")
        os.unlink(tmp_jsonl)
        os.unlink(tmp_zst)
        sys.exit(1)
    n_new = check.stdout.count(b"\n")
    if n_new < stats["lines"] - 5:
        print(f"ABORT: 事件数 {n_new} 少于预期 {stats['lines']}")
        os.unlink(tmp_jsonl)
        os.unlink(tmp_zst)
        sys.exit(1)

    bak = path + f".bak-defrag-{time.strftime('%Y%m%dT%H%M%S')}"
    os.replace(path, bak)
    os.replace(tmp_zst, path)
    os.unlink(tmp_jsonl)
    print(f"\n已替换。备份：{bak}")


if __name__ == "__main__":
    main()
