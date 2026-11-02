#!/bin/bash
# 兜底：用 cliclick 点屏幕坐标。只在 AX 自动化不可用、又能确认弹框按钮坐标时人工使用。
# 注意：cliclick 需要 Accessibility 权限；会移动鼠标指针，但不会激活 app。
# 用法: dsh-click.sh <x> <y>
set -u
X="${1:-}"
Y="${2:-}"
if [ -z "$X" ] || [ -z "$Y" ]; then
  echo "用法: dsh-click.sh <x> <y>"
  exit 1
fi
if ! command -v cliclick >/dev/null 2>&1; then
  echo "cliclick 未安装（brew install cliclick）"
  exit 1
fi
printf '%s [click] %s,%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$X" "$Y" >>"$HOME/.dsh/tools/guard.log"
cliclick "c:${X},${Y}"
