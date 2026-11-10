#!/bin/bash
# 依赖自愈：node_modules 不存在、或 pnpm-lock.yaml 比它新，就重装一次。
# 被 start.sh source，不单独执行。

ensure_deps() {
  local root="$1"
  local need=0

  if [ ! -d "$root/node_modules" ]; then
    echo "  依赖未安装，执行 pnpm install ..."
    need=1
  elif [ -f "$root/pnpm-lock.yaml" ] && [ "$root/pnpm-lock.yaml" -nt "$root/node_modules" ]; then
    echo "  pnpm-lock.yaml 比 node_modules 新，重新安装 ..."
    need=1
  fi

  if [ "$need" -eq 1 ]; then
    ( cd "$root" && pnpm install ) || {
      echo "  ✗ pnpm install 失败"
      return 1
    }
    # esbuild 的 postinstall 会被 pnpm 的 onlyBuiltDependencies 策略拦下，
    # 显式 rebuild 一次，否则 vite / tsx 起不来。
    ( cd "$root" && pnpm rebuild esbuild >/dev/null 2>&1 ) || true
  fi
  return 0
}
