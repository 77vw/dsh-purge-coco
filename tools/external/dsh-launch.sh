#!/bin/bash
# 以"不抢前台"的方式启动 DSH，并保证带 --remote-debugging-port=9223。
# 用法: dsh-launch.sh
# 退出码: 0 已启动/已在运行 / 1 启动失败
set -u
. "$HOME/.dsh/tools/dsh-common.sh"
LOG="$TOOLS/guard.log"
STATE="$TOOLS/.dsh-managed-pid"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "[launch] $*" >>"$LOG"; }

clean_env
[ -n "$NODE" ] || { log "找不到 node"; exit 1; }

if [ -n "$(main_pids)" ]; then
  log "已在运行，跳过启动 pid=$(main_pids | tr '\n' ' ')"
  exit 0
fi

# Electron 冷启动时 window.show() 一定会把 app 激活到前台。
# 记录启动前的前台 app；启动完成后在**前台**轮询几秒，发现 DSH 抢到前台就立刻还回去。
FRONT_BID="$(/usr/bin/lsappinfo info -only bundleid "$(/usr/bin/lsappinfo front 2>/dev/null)" 2>/dev/null | /usr/bin/sed -E 's/.*="(.*)"/\1/')"
[ "$FRONT_BID" = "com.deepseek.dsh" ] && FRONT_BID=""

restore_focus() {
  [ -n "$FRONT_BID" ] || return 0
  local bid restored=0
  for _ in $(seq 1 100); do
    bid="$(/usr/bin/lsappinfo info -only bundleid "$(/usr/bin/lsappinfo front 2>/dev/null)" 2>/dev/null | /usr/bin/sed -E 's/.*="(.*)"/\1/')"
    if [ "$bid" = "com.deepseek.dsh" ]; then
      /usr/bin/open -b "$FRONT_BID" >/dev/null 2>&1
      restored=$((restored + 1))
      log "已把前台还给 ${FRONT_BID}（第 ${restored} 次）"
      [ "$restored" -ge 2 ] && break
      sleep 0.4
    fi
    sleep 0.08
  done
}


# 端口还被旧进程占着就先等它释放，否则新实例会弹 EADDRINUSE 恢复框
for _ in $(seq 1 40); do port_free && break; sleep 0.25; done

# 首选 LaunchServices 后台启动：-g 不激活、不抢焦点，--args 在冷启动时有效
/usr/bin/open -g -a "$APP" --args --remote-debugging-port=9223 >/dev/null 2>&1

for _ in $(seq 1 40); do
  sleep 0.5
  cdp_ok && break
done

if [ -z "$(main_pids)" ]; then
  # open 被 LaunchServices 判定为"已在运行"而不启动时，退回直接执行二进制
  log "open -g 未产生进程，改用直接执行"
  nohup "$EXE" --remote-debugging-port=9223 >/dev/null 2>&1 &
  for _ in $(seq 1 40); do sleep 0.5; cdp_ok && break; done
elif ! cdp_ok && ! main_has_debug_flag; then
  # 极少数情况下 --args 没传进去：进程起来了但没有 9223，杀掉重来
  log "进程已起但没带调试端口，杀掉重来（直接执行二进制）"
  kill -9 $(main_pids) 2>/dev/null
  for _ in $(seq 1 24); do sleep 0.25; [ -z "$(main_pids)" ] && break; done
  nohup "$EXE" --remote-debugging-port=9223 >/dev/null 2>&1 &
  for _ in $(seq 1 40); do sleep 0.5; cdp_ok && break; done
fi

PIDS="$(main_pids | tr '\n' ' ')"
if [ -z "$PIDS" ]; then
  log "启动失败：仍然没有主进程"
  exit 1
fi

printf '%s\n' $PIDS | head -1 >"$STATE"
if cdp_ok; then
  log "启动成功 pid=$PIDS CDP=up"
else
  log "进程已起 pid=$PIDS 但 CDP 未就绪（下一轮继续观察）"
fi

# 冷启动后 DSH 的 window.show() 会抢前台；这里把它还回去（最多 8 秒、最多 2 次）
restore_focus
exit 0
