#!/bin/sh
# 停止控制台（同时停掉它管理的 llama-server）
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"

# 先停 llama-server
PIDS="$(lsof -ti tcp:"$SERVE_PORT" 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null && echo "已停止 llama-server（端口 $SERVE_PORT）"
fi

PIDFILE="$STRATA_HOME/run/console.pid"
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && echo "已停止控制台（PID ${PID}）"
    rm -f "$PIDFILE"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

PIDS="$(lsof -ti tcp:"$WEB_PORT" 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null && echo "已停止占用 $WEB_PORT 端口的进程"
else
  echo "控制台未在运行"
fi
