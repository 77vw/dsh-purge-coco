#!/bin/bash
# launchd 入口：跑一次会话续跑检查。日志在 continue.log。
set -u
. "$HOME/.dsh/tools/dsh-common.sh"
[ -n "$NODE" ] || exit 0
[ -f "$HOME/.dsh/tools/PAUSED" ] && exit 0
exec "$NODE" "$HOME/.dsh/tools/dsh-continue.mjs" "$@" >>"$HOME/.dsh/tools/continue-launchd.log" 2>&1
