#!/bin/sh
# 后台启动控制台，并阻塞到服务就绪后返回。
# .app 启动器依赖这个行为：它调用本脚本后立刻做健康检查。
# 想在前台看实时日志，请用 ./run-console.sh
#
# 额外逻辑：检测 server.mjs / index.html 是否被改过，改过就先杀掉旧进程再启动，
# 避免「代码更新了但旧进程还在跑」造成的困惑。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"

HEALTH="http://127.0.0.1:$WEB_PORT/api/state"
mkdir -p "$STRATA_HOME/logs" "$STRATA_HOME/run"

STAMP="$STRATA_HOME/run/code.stamp"
FP_SERVER="$(stat -f '%m-%z' "$STRATA_HOME/server.mjs" 2>/dev/null || echo x)"
FP_PAGE="$(stat -f '%m-%z' "$STRATA_HOME/public/index.html" 2>/dev/null || echo y)"
FINGERPRINT="$FP_SERVER-$FP_PAGE"

# 代码指纹变了 → 杀掉旧进程
if [ -f "$STAMP" ]; then
  LAST="$(cat "$STAMP" 2>/dev/null || echo '')"
  if [ "$FINGERPRINT" != "$LAST" ]; then
    OLD="$(lsof -ti tcp:"$WEB_PORT" 2>/dev/null || true)"
    if [ -n "$OLD" ]; then
      echo "$OLD" | xargs kill 2>/dev/null || true
      sleep 1
    fi
  fi
fi
echo "$FINGERPRINT" > "$STAMP"

# 就绪判断：连得上，且响应确实来自本控制台
ready() {
  /usr/bin/curl -s -m 2 "$HEALTH" 2>/dev/null | /usr/bin/grep -q '"modelRoots"'
}

if ready; then
  exit 0
fi

cd "$STRATA_HOME"
CONSOLE_PORT="$WEB_PORT" nohup "$NODE_BIN" server.mjs >> "$STRATA_HOME/logs/console.log" 2>&1 &
echo $! > "$STRATA_HOME/run/console.pid"

# 等待就绪，最多 25 秒
i=0
while [ "$i" -lt 50 ]; do
  if ready; then
    exit 0
  fi
  sleep 0.5
  i=$((i + 1))
done

exit 1
