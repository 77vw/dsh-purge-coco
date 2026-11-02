#!/bin/bash
# DSH 存活守护（launchd ai.dsh.guard，每 60 秒）。
#
# 三层检查，越往后越谨慎：
#   1. 主进程不在          → 后台拉起（open -g，不抢焦点）
#   2. 进程在但 CDP 不通    → 只有"本守护拉起的进程"才重启；用户手动启动的只记录
#   3. 白屏/渲染器无响应    → 连续 2 次才软重载（不杀进程）；软重载失败且累计 3 次才重启
#
# 所有重启都经过 dsh-restart.sh 的频率限制（10 分钟 2 次 / 1 小时 6 次熔断）。
# 临时停用：touch ~/.dsh/tools/PAUSED
set -u
. "$HOME/.dsh/tools/dsh-common.sh"
LOG="$TOOLS/guard.log"
PAUSE="$TOOLS/PAUSED"
STRIKE="$TOOLS/.guard-white-strikes"
LOCK="$TOOLS/.guard.lock"
COOLDOWN="$TOOLS/.dsh-restart-cooldown"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "[guard] $*" >>"$LOG"; }

[ -f "$PAUSE" ] && exit 0
[ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 524288 ] && : >"$LOG"
[ -n "$NODE" ] || { log "找不到 node（command -v node 与 ~/.local/bin/node 都失败），跳过本轮"; exit 0; }

# 互斥：上一轮还没跑完就跳过
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD=$(cat "$LOCK/pid" 2>/dev/null || echo 0)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then exit 0; fi
  rm -rf "$LOCK" 2>/dev/null
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

if [ -f "$COOLDOWN" ] && [ "$(cat "$COOLDOWN" 2>/dev/null || echo 0)" -gt "$(date +%s)" ]; then
  log "重启熔断冷却中，本轮只检查"
fi

# ---- 1. 进程存活 ----
PIDS="$(main_pids | tr '\n' ' ')"
if [ -z "$PIDS" ]; then
  log "主进程不在，拉起"
  "$TOOLS/dsh-launch.sh"
  exit 0
fi

# ---- 2. CDP ----
if ! cdp_ok; then
  OWNER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$OWNER" ]; then
    log "CDP 无响应但端口被 pid=$OWNER 占用，等下一轮"
    exit 0
  fi
  MANAGED="$(cat "$TOOLS/.dsh-managed-pid" 2>/dev/null || echo)"
  if main_has_debug_flag; then
    log "本守护拉起的进程丢失 CDP 端口，重启恢复"
    "$TOOLS/dsh-restart.sh" hard
  else
    log "进程在($PIDS)但没有调试端口，且不是本守护拉起（managed=${MANAGED:-none}）；不重启，避免误杀用户手动启动的实例"
  fi
  exit 0
fi

# ---- 3. 后端 host 存活（host 死了：窗口还在、CDP 还通，但会话跑不动）----
FIRST_PID=$(echo $PIDS | awk '{print $1}')
AGE=$(proc_age "$FIRST_PID")
case "$AGE" in ''|*[!0-9]*) AGE=999999 ;; esac
if [ "$AGE" -lt 30 ]; then
  log "主进程刚启动 ${AGE}s，跳过 host/白屏判定（避免把启动中当成故障）"
  exit 0
fi

HOST_STRIKE="$TOOLS/.guard-host-strikes"
if [ -z "$(host_pids)" ]; then
  H=$(cat "$HOST_STRIKE" 2>/dev/null || echo 0)
  case "$H" in ''|*[!0-9]*) H=0 ;; esac
  H=$((H + 1))
  echo "$H" >"$HOST_STRIKE"
  log "Host 子进程不在（第 ${H} 次），会话后端已死"
  if [ "$H" -ge 2 ]; then
    log "Host 连续 ${H} 次缺失，重启"
    "$TOOLS/dsh-restart.sh" hard
    echo 0 >"$HOST_STRIKE"
  fi
  exit 0
fi
echo 0 >"$HOST_STRIKE"

# ---- 4. 页面健康（白屏 / 渲染器卡死）----
LEN=""
READY=""
for _ in 1 2; do
  RAW="$("$NODE" "$TOOLS/dsh-eval.mjs" 'JSON.stringify({len:document.body.innerText.length,ready:document.readyState})' 2>/dev/null)"
  LEN="$(printf '%s' "$RAW" | sed -E 's/.*"len":([0-9]+).*/\1/' | tr -dc '0-9')"
  READY="$(printf '%s' "$RAW" | sed -E 's/.*"ready":"([a-z]+)".*/\1/')"
  [ -n "$LEN" ] && break
  sleep 1
done

if [ "$READY" != "complete" ] && [ -n "$LEN" ]; then
  log "页面还在加载（readyState=${READY:-?}），跳过本轮"
  exit 0
fi

BAD=0
if [ -z "$LEN" ]; then
  BAD=1
  REASON="CDP 能连但取不到 innerText（渲染器无响应）"
elif [ "$LEN" -lt 200 ] 2>/dev/null; then
  BAD=1
  REASON="页面疑似白屏 innerText=${LEN}"
else
  echo 0 >"$STRIKE"
  exit 0
fi

N=$(cat "$STRIKE" 2>/dev/null || echo 0)
case "$N" in ''|*[!0-9]*) N=0 ;; esac
N=$((N + 1))
echo "$N" >"$STRIKE"
log "${REASON}（第 ${N} 次）"

if [ "$N" -eq 2 ]; then
  log "尝试软重载（不杀进程）"
  if "$NODE" "$TOOLS/dsh-reload.mjs" 20 >/dev/null 2>&1; then
    echo 0 >"$STRIKE"
    log "软重载成功，页面已恢复"
    exit 0
  fi
  log "软重载失败"
fi

if [ "$N" -ge 3 ]; then
  log "连续 ${N} 次异常，走重启"
  "$TOOLS/dsh-restart.sh" hard
  echo 0 >"$STRIKE"
fi

exit 0
