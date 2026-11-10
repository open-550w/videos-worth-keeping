#!/bin/bash
# Videos Worth Keeping 启动脚本
#
# 关键点：**必须让服务脱离会话**。
#
# Claude Code / 终端在会话结束时会**给整个进程组发信号**（Claude 用 --pgroup 起 agent）。
# 普通的 `nohup ... &` 挡不住这个 —— 进程落在同一个进程组里，会话一关就被连坐杀掉。
# 症状很迷惑：手动跑得好好的，隔一条命令再看就没了，而且没有任何错误日志。
#
# 所以 macOS 上用 `launchctl submit`（走 detached spawn，被 launchd 收养，ppid=1），
# 其他平台退回 `setsid`/`nohup`。
#
# 用法：pnpm start

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
eval "$(node "$PROJECT_ROOT/scripts/config.mjs" shell)"


mkdir -p "$PID_DIR" "$LOG_DIR"

source "$SCRIPT_DIR/deps.sh"

# 从 env 文件读变量，找不到用默认值（顺手剥掉首尾引号 —— .env.local 里的
# 密码含 # 建议加引号 —— 理由见 docs/init/03_TECH_STACK.md §6.1；
# 这里剥掉首尾引号不影响使用）
env_val() {
  local file=$1 var=$2 default=$3 val=""
  if [ -f "$file" ]; then
    val=$(grep -E "^${var}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2-)
    val="${val#\"}"; val="${val%\"}"
    val="${val#\'}"; val="${val%\'}"
  fi
  [ -n "$val" ] && echo "$val" || echo "$default"
}

BACKEND_ENV="$PROJECT_ROOT/packages/backend/.env.local"
WEB_ENV="$PROJECT_ROOT/packages/web/.env"


WORKTREE_ID=$(printf "%s" "$PROJECT_ROOT" | shasum | cut -c1-12)
LAUNCH_LABEL_PREFIX="com.videos-worth-keeping.local.$WORKTREE_ID"

kill_port() {
  local port=$1 pids owned=0 pidfile recorded
  pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  for pidfile in "$PID_DIR/backend.pid" "$PID_DIR/web.pid"; do
    [ -f "$pidfile" ] || continue
    recorded=$(cat "$pidfile")
    [ "$recorded" = "$pids" ] && owned=1
  done
  if [ "$owned" -ne 1 ]; then
    echo "错误: 端口 $port 已被其它服务占用；请修改配置，未停止该服务。"
    return 1
  fi
  kill $pids 2>/dev/null || true
  sleep 1
}

show_log_tail() {
  local log_file=$1 lines=${2:-20}
  if [ -f "$log_file" ] && [ -s "$log_file" ]; then
    tail -n "$lines" "$log_file" | sed 's/^/      /'
  else
    echo "      （日志为空）"
  fi
}

# 启动一个服务。关键：**脱离会话**。
start_service() {
  local name=$1 port=$2 pkg=$3 wait_secs=$4
  local pid_file="$PID_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"
  echo "  启动 $name ..."
  local launcher="" label
  label="$LAUNCH_LABEL_PREFIX.$name"

  if [ "$(uname)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
    launchctl remove "$label" >/dev/null 2>&1 || true
    launchctl submit -l "$label" -o "$log_file" -e "$log_file" -- \
      /bin/bash -lc 'cd "$1" && exec pnpm --filter "$2" dev' _ "$PROJECT_ROOT" "$pkg"
  else
    # 非 macOS：用 setsid 脱离进程组；没有 setsid 就退回 nohup（可能被连坐）
    if command -v setsid >/dev/null 2>&1; then
      setsid bash -c 'cd "$1" && exec pnpm --filter "$2" dev' _ "$PROJECT_ROOT" "$pkg" \
        </dev/null >"$log_file" 2>&1 &
    else
      nohup bash -c 'cd "$1" && exec pnpm --filter "$2" dev' _ "$PROJECT_ROOT" "$pkg" \
        </dev/null >"$log_file" 2>&1 &
    fi
    launcher=$!
  fi

  local i real_pid=""
  for i in $(seq 1 $((wait_secs * 2))); do
    real_pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n1)
    if [ -n "$real_pid" ]; then
      echo "$real_pid" >"$pid_file"
      echo "  ✓ $name 已启动 (PID: $real_pid, http://localhost:$port, 日志: $log_file)"
      return 0
    fi
    # 启动进程已退出（依赖缺失 / 端口冲突 / 代码报错）→ 立刻失败，别等满超时
    if [ -n "$launcher" ] && ! kill -0 "$launcher" 2>/dev/null; then
      echo "  ✗ $name 启动失败（进程提前退出），日志尾部："
      show_log_tail "$log_file"
      return 1
    fi
    sleep 0.5
  done

  echo "  ✗ $name 启动失败（端口 $port 在 ${wait_secs}s 内未监听），日志尾部："
  show_log_tail "$log_file"
  return 1
}

# 启动前的数据库自检。
#
# ⚠️ 两个坑都踩过，都写在这里免得再犯：
#
# ① **不能把 ping 接到管道里再用 `if !` 判**。
#    `pnpm ... ping | sed ...` 的退出码是 **sed** 的，不是 pnpm 的 ——
#    ping 失败了 sed 照样成功，于是 `if !` 认为检查通过，**照样把服务起起来**。
#    实测过：屏幕上打印着「连不上数据库」，下面紧接着「✓ backend 已启动」。
#    所以要**先把退出码接住**再格式化输出。
#
# ② **要重试**。这条网络实测丢包严重、建连要 1–11 秒（见 03_TECH_STACK.md §1.3），
#    单次超时是常态。一次不通就中止启动，等于网络一抖就打不开站。
#    连续 3 次都失败才判定「真的连不上」。
DB_CHECK_ATTEMPTS=${DB_CHECK_ATTEMPTS:-3}

db_selfcheck() {
  local attempt out rc
  for attempt in $(seq 1 "$DB_CHECK_ATTEMPTS"); do
    # 关键：先接住退出码，再格式化输出
    out=$( cd "$PROJECT_ROOT" && pnpm --filter @likes/backend ping 2>&1 )
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "$out" | grep -E "mysql|sqlite" | tail -n1 | sed 's/^/      /'
      [ "$attempt" -gt 1 ] && echo "      （第 $attempt 次才通 —— 这条网络确实不稳）"
      return 0
    fi
    # pnpm 的输出里真正有用的是 ping.cli.ts 打的那两行，
    # 「ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / Exit status 1」是包装层的噪音，不显示
    echo "      第 $attempt/$DB_CHECK_ATTEMPTS 次失败：$(echo "$out" | grep -E '连不上数据库' | tail -n1 | sed 's/.*连不上数据库：//')"
    [ "$attempt" -lt "$DB_CHECK_ATTEMPTS" ] && sleep 2
  done
  echo ""
  echo "$out" | grep -E "连不上数据库|→" | sed 's/^[[:space:]]*/      /'
  return 1
}

echo "🔧 Videos Worth Keeping 启动中..."
echo ""

command -v pnpm >/dev/null 2>&1 || { echo "错误: pnpm 未安装"; exit 1; }

ensure_deps "$PROJECT_ROOT"

echo "  自检数据库 ..."
if ! db_selfcheck; then
  echo ""
  echo "❌ 数据库连续 $DB_CHECK_ATTEMPTS 次都连不上，已中止启动。"
  echo "   （不中止的话你会对着一个空页面猜是不是功能坏了）"
  exit 1
fi

kill_port "$BACKEND_PORT"
kill_port "$WEB_PORT"

rc=0
start_service "backend" "$BACKEND_PORT" "@likes/backend" 60 || rc=1
start_service "web"     "$WEB_PORT"     "@likes/web"     30 || rc=1

echo ""
if [ "$rc" -ne 0 ]; then
  echo "❌ 启动未完全成功，看上面的日志尾部排查。"
  exit 1
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")
echo "✅ 已启动!"
echo ""
echo "📊 服务:"
echo "  - web:     http://localhost:$WEB_PORT"
echo "  - backend: http://localhost:$BACKEND_PORT  (API)"
if [ -n "$LAN_IP" ]; then
  echo ""
  echo "📱 手机（同一 WiFi）: http://$LAN_IP:$WEB_PORT"
fi
echo ""
echo "🛑 停止: pnpm stop   📋 状态: pnpm status   📜 日志: pnpm log"
