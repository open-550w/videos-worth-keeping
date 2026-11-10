#!/bin/bash
# 停止 Videos Worth Keeping。
#
# 两条路都走：先 launchctl remove（macOS 上服务是 launchd 收养的，
# 只 kill 端口的话 launchd 可能把它拉回来），再按端口兜底 kill。
#
# 用法：pnpm stop

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


WORKTREE_ID=$(printf "%s" "$PROJECT_ROOT" | shasum | cut -c1-12)
LAUNCH_LABEL_PREFIX="com.videos-worth-keeping.local.$WORKTREE_ID"

echo "🛑 停止中..."

for name in backend web; do
  if [ "$(uname)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
    launchctl remove "$LAUNCH_LABEL_PREFIX.$name" >/dev/null 2>&1 && echo "  已移除 launchd 服务 $name" || true
  fi

done

kill_port() {
  local port=$1 label=$2
  local pids
  pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    local recorded=""
    [ -f "$PID_DIR/$label.pid" ] && recorded=$(cat "$PID_DIR/$label.pid")
    if [ "$recorded" != "$pids" ]; then
      echo "  $label 端口由其它进程占用，未停止该进程"
      return 0
    fi
    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill -9 $pids 2>/dev/null || true
    fi
    echo "  已释放 $label (端口 $port)"
  else
    echo "  $label 未在运行 (端口 $port)"
  fi
}

kill_port "$BACKEND_PORT" "backend"
kill_port "$WEB_PORT" "web"

rm -f "$PID_DIR/backend.pid" "$PID_DIR/web.pid"
echo "✅ 已停止"
