#!/bin/bash
# 看服务状态。
#
# ⚠️ 判据是**进程组（pgid）**，不是 ppid，也不是进程树的根。
#
# 为什么 ppid 不行：我们用 `launchctl submit` 起服务，监听端口的进程是
# launchd 任务的**孙进程**（launchd → pnpm → node → node），它的父进程当然是 pnpm。
#
# 为什么进程树的根也不行（这个更隐蔽）：实测**普通 `nohup ... &` 起的进程，
# 父链最终也会终止在 launchd**（pid 1）—— 和 launchctl 起的看起来一模一样。
# 用它做判据会**永远报「已脱离」**，包括那些真的会被杀掉的进程。
#
# 真正区分两者的是 pgid（实测）：
#   launchctl 起的：pgid 38797，调用方 shell 的 pgid 54750 —— 不同组，安全
#   nohup & 起的：  pgid 54750，和调用方 shell **同组** —— 会被连坐
# 因为会话结束时的信号是**发给整个进程组**的。
#
# 所以：服务的 pgid 和本脚本的 pgid 相同 → 在同一个组里 → 会话一结束就会死。
#
# 用法：pnpm status

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
eval "$(node "$PROJECT_ROOT/scripts/config.mjs" shell)"

env_val() {
  local file=$1 var=$2 default=$3 val=""
  if [ -f "$file" ]; then
    val=$(grep -E "^${var}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2-)
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
  fi
  [ -n "$val" ] && echo "$val" || echo "$default"
}


pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

MY_PGID=$(pgid_of $$)

show() {
  local name=$1 port=$2
  local pid pgid
  pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n1 || true)
  if [ -z "$pid" ]; then
    printf "  %-8s ✗ 未运行 (端口 %s)\n" "$name" "$port"
    return
  fi
  pgid=$(pgid_of "$pid")
  if [ "$pgid" = "$MY_PGID" ]; then
    printf "  %-8s ⚠ 运行中  PID=%s  端口=%s  会话归属=**和本 shell 同进程组(pgid=%s)** —— 会话一结束就会死\n" \
      "$name" "$pid" "$port" "$pgid"
  else
    printf "  %-8s ✓ 运行中  PID=%s  端口=%s  会话归属=已脱离(pgid=%s ≠ 本 shell 的 %s)\n" \
      "$name" "$pid" "$port" "$pgid" "$MY_PGID"
  fi
}

echo "📊 Videos Worth Keeping 状态"
echo ""
show "backend" "$BACKEND_PORT"
show "web" "$WEB_PORT"
echo ""

echo -n "  database "
if ( cd "$PROJECT_ROOT" && pnpm --filter @likes/backend ping >/tmp/likes-ping.out 2>&1 ); then
  echo "✓ $(tail -n1 /tmp/likes-ping.out)"
else
  echo "✗ $(tail -n1 /tmp/likes-ping.out)"
fi
rm -f /tmp/likes-ping.out
echo ""
