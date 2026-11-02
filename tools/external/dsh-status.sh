#!/bin/bash
# 一次性状态报告（人工排查用）。
# 用法: dsh-status.sh [--shot]
set -u
. "$HOME/.dsh/tools/dsh-common.sh"
SHOT=0
[ "${1:-}" = "--shot" ] && SHOT=1

echo "== DSH 状态 $(date '+%Y-%m-%d %H:%M:%S') =="
PIDS="$(main_pids | tr '\n' ' ')"
echo "主进程 pid : ${PIDS:-（不在）}"
echo "managed pid: $(cat "$TOOLS/.dsh-managed-pid" 2>/dev/null || echo none)"
echo "CDP        : $(cdp_ok && echo up || echo down)  owner=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)"
echo "暂停开关   : $([ -f "$TOOLS/PAUSED" ] && echo '已暂停(PAUSED 存在)' || echo '运行中')"
echo "白屏计数   : $(cat "$TOOLS/.guard-white-strikes" 2>/dev/null || echo 0)"
echo "重启历史   : $(tail -5 "$TOOLS/.dsh-restart-history" 2>/dev/null | tr '\n' ' ')"
echo "最近重启   : $(tail -3 "$TOOLS/guard.log" 2>/dev/null | grep restart | tail -3)"
echo "继续状态   : $(cat "$TOOLS/.dsh-continue-state.json" 2>/dev/null | tr -d '\n' | head -c 300)"
echo "--- signal"
"$NODE" "$TOOLS/dsh-signal.mjs" --pretty 2>&1
echo "--- launchd"
launchctl list 2>/dev/null | grep -i "ai.dsh" || true
if [ "$SHOT" -eq 1 ]; then
  OUT="$TOOLS/evidence/status-$(date +%H%M%S).png"
  mkdir -p "$TOOLS/evidence"
  screencapture -x -o "$OUT" 2>/dev/null && echo "截图: $OUT" || echo "截图失败（可能缺少屏幕录制权限）"
fi
