#!/bin/bash
# 看日志。用法：pnpm log [backend|web] [行数]
#   pnpm log            两个都看，各 30 行
#   pnpm log backend 100

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
eval "$(node "$PROJECT_ROOT/scripts/config.mjs" shell)"


which=${1:-both}
lines=${2:-30}

show_one() {
  local name=$1
  local f="$LOG_DIR/$name.log"
  echo "──────── $name ($f) ────────"
  if [ -f "$f" ]; then
    tail -n "$lines" "$f"
  else
    echo "(还没有日志 —— 服务没起过？)"
  fi
  echo ""
}

case "$which" in
  backend) show_one backend ;;
  web)     show_one web ;;
  *)       show_one backend; show_one web ;;
esac
