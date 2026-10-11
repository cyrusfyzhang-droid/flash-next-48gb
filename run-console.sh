#!/bin/sh
# 前台运行控制台（供 launchd 或手动调试使用）
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"
cd "$APP_HOME"
exec "$NODE_BIN" server.mjs
