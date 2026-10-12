#!/bin/sh
# LaunchAgent 守护入口（com.cyrus.strata-console）
# source 环境后 exec node —— exec 是进程替换，launchd 直接守护 node 本身，
# 崩溃自动重启、开机自启，不再依赖终端会话存活。
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"
cd "$APP_HOME"
export CONSOLE_PORT="${WEB_PORT:-8791}"
exec "$NODE_BIN" server.mjs
