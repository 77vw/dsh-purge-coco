#!/bin/bash
# 公共函数与路径。被 dsh-guard.sh / dsh-restart.sh / dsh-launch.sh 引用。
TOOLS="$HOME/.dsh/tools"
EXE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
APP="/Applications/DeepSeek Harness.app"
CDP="http://127.0.0.1:9223/json/list"
PORT=9223

pick_node() {
  local n
  n="$(command -v node 2>/dev/null || true)"
  [ -x "$n" ] || n="$HOME/.local/bin/node"
  [ -x "$n" ] || n=""
  printf '%s' "$n"
}
NODE="$(pick_node)"

# 只认 Electron 主进程：命令以 EXE 开头，且不是 host 子进程(--expose-internals) / helper(--type=)
main_pids() {
  ps -Ao pid=,command= | awk -v exe="$EXE" '
    {
      line = $0
      sub(/^ *[0-9]+ +/, "", line)
      if (index(line, exe) != 1) next
      rest = substr(line, length(exe) + 1)
      if (rest ~ /^ *$/) { print $1; next }
      if (rest ~ /^ --remote-debugging-port/) { print $1; next }
    }'
}

cdp_ok() { curl -sf -m 2 "$CDP" >/dev/null 2>&1; }

# 主进程是否带调试端口（只有本守护拉起的实例才带）
main_has_debug_flag() {
  ps -Ao command= | awk -v exe="$EXE" '
    { if (index($0, exe) != 1) next
      rest = substr($0, length(exe) + 1)
      if (rest ~ /^ --remote-debugging-port/) { found = 1; exit } }
    END { exit(found ? 0 : 1) }'
}

# DSH 的后端 host 子进程（Electron 主进程的子进程，负责跑会话）
host_pids() {
  ps -Ao pid=,command= | awk -v exe="$EXE" '
    {
      line = $0
      sub(/^ *[0-9]+ +/, "", line)
      if (index(line, exe) != 1) next
      rest = substr(line, length(exe) + 1)
      if (rest ~ /^ --expose-internals/) { print $1 }
    }'
}

# 主进程已运行的秒数（用于避免"刚启动、页面还在加载"被当成白屏）
proc_age() {
  ps -p "$1" -o etime= 2>/dev/null | tr -d ' ' | awk -F'[-:]' '
    NF == 4 { print $1 * 86400 + $(NF-2) * 3600 + $(NF-1) * 60 + $NF; next }
    NF == 3 { print $(NF-2) * 3600 + $(NF-1) * 60 + $NF; next }
    NF == 2 { print $(NF-1) * 60 + $NF; next }
    NF == 1 { print $1; next }
    { print 999999 }'
}

port_free() { ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# 任何来自 DSH 内嵌 shell 的环境都可能带 ELECTRON_RUN_AS_NODE=1，
# 会让 Electron 以 node 模式启动后立刻退出（表现为"拉不起来"）。
clean_env() {
  unset ELECTRON_RUN_AS_NODE
  unset NODE_OPTIONS
}
