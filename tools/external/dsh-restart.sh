#!/bin/bash
# 无弹框重启 DSH：只杀 Electron 主进程（不杀 helper，避免触发 render-process-gone 崩溃框），
# 等端口释放后用 open -g 后台拉起（不抢焦点），最后验证 CDP + 页面。
# 用法: dsh-restart.sh [hard|graceful] [--force]
# 退出码: 0 成功 / 1 失败 / 75 触发 10 分钟 2 次上限 / 76 触发熔断
set -u
. "$HOME/.dsh/tools/dsh-common.sh"
LOG="$TOOLS/guard.log"
HIST="$TOOLS/.dsh-restart-history"
COOLDOWN="$TOOLS/.dsh-restart-cooldown"

MODE="${1:-hard}"
FORCE=0
for a in "$@"; do [ "$a" = "--force" ] && FORCE=1; done

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "[restart] $*" >>"$LOG"; }

now=$(date +%s)

# 熔断冷却中
if [ -f "$COOLDOWN" ]; then
  until=$(cat "$COOLDOWN" 2>/dev/null || echo 0)
  if [ "${until:-0}" -gt "$now" ] 2>/dev/null; then
    log "熔断冷却中，剩余 $((until - now)) 秒，跳过"
    exit 76
  fi
fi

# 频率限制：10 分钟最多 2 次；1 小时最多 6 次
touch "$HIST"
awk -v n="$now" '$1 > n - 3600' "$HIST" >"$HIST.tmp" 2>/dev/null && mv "$HIST.tmp" "$HIST"
if [ "$FORCE" -ne 1 ]; then
  c10=$(awk -v n="$now" '$1 > n - 600' "$HIST" | wc -l | tr -d ' ')
  c60=$(awk -v n="$now" '$1 > n - 3600' "$HIST" | wc -l | tr -d ' ')
  if [ "$c60" -ge 6 ]; then
    echo $((now + 1800)) >"$COOLDOWN"
    log "1 小时内已重启 ${c60} 次，熔断 30 分钟（防止重启风暴）"
    exit 76
  fi
  if [ "$c10" -ge 2 ]; then
    log "10 分钟内已重启 ${c10} 次，达到上限，跳过本次"
    exit 75
  fi
fi

log "开始重启 mode=$MODE"

# 弹框清理器（AX 不可用就跳过；正常路径本身不产生弹框）
DISMISS_PID=""
if "$NODE" "$TOOLS/dsh-dismiss.mjs" --probe >/dev/null 2>&1; then
  "$NODE" "$TOOLS/dsh-dismiss.mjs" --watch 20 >>"$LOG" 2>&1 &
  DISMISS_PID=$!
  log "弹框清理器已启动（AX 可用）"
else
  log "AX 不可用（launchd 无 TCC 授权），走无弹框路径：只杀主进程"
fi

PIDS="$(main_pids | tr '\n' ' ')"
if [ -n "$PIDS" ]; then
  if [ "$MODE" = "graceful" ]; then
    # shellcheck disable=SC2086
    kill -TERM $PIDS 2>/dev/null
    for _ in $(seq 1 16); do sleep 0.5; [ -z "$(main_pids)" ] && break; done
  fi
  LEFT="$(main_pids | tr '\n' ' ')"
  if [ -n "$LEFT" ]; then
    # 只杀主进程：helper 会随父进程退出；先杀 helper 会弹崩溃恢复框
    # shellcheck disable=SC2086
    kill -9 $LEFT 2>/dev/null
  fi
else
  log "没有主进程在跑，直接拉起"
fi

for _ in $(seq 1 40); do sleep 0.25; [ -z "$(main_pids)" ] && break; done
for _ in $(seq 1 40); do port_free && break; sleep 0.25; done

echo "$now" >>"$HIST"

"$TOOLS/dsh-launch.sh"
LAUNCH_RC=$?

# 验证：CDP 可达 + 页面有内容
OK=0
for _ in $(seq 1 40); do
  sleep 0.5
  LEN="$("$NODE" "$TOOLS/dsh-eval.mjs" 'document.body.innerText.length' 2>/dev/null | tr -dc '0-9')"
  if [ -n "$LEN" ] && [ "$LEN" -ge 200 ] 2>/dev/null; then OK=1; break; fi
done

if [ -n "$DISMISS_PID" ]; then
  # 弹框清理器最多再盯 2 秒（正常路径没有弹框，不等它跑满 20 秒）
  for _ in $(seq 1 4); do
    kill -0 "$DISMISS_PID" 2>/dev/null || break
    sleep 0.5
  done
  kill "$DISMISS_PID" 2>/dev/null
fi

if [ "$OK" -eq 1 ]; then
  log "重启完成：页面 ${LEN} 字符，CDP 正常"
  exit 0
fi

log "重启失败：CDP/页面未恢复（launch rc=${LAUNCH_RC}）"
exit 1
