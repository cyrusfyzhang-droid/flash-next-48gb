#!/bin/sh
# 共享环境变量 —— 所有脚本 source 这一个文件
# （.app 与 launchd 的 PATH 极小，必须在这里补全）
#
# 想改成本机路径，不要直接改这个文件，而是新建 config.local.sh
# （已被 .gitignore 排除），示例见 config.local.sh.example

# 项目根目录：优先沿用调用脚本所在目录，否则退回当前工作目录
export APP_HOME="${APP_HOME:-${DIR:-$(pwd)}}"

export WEB_PORT="${WEB_PORT:-8791}"       # 控制台界面端口
export SERVE_PORT="${SERVE_PORT:-8080}"   # llama-server 端口

# llama.cpp 编译产物目录（需包含 llama-server 可执行文件）
export LLAMA_BIN="${LLAMA_BIN:-$HOME/llama.cpp/build/bin}"

# 模型扫描目录，冒号分隔多个。子目录会被递归扫描，自动识别 GGUF 分片。
export MODEL_DIRS="${MODEL_DIRS:-$HOME/models:$HOME/.cache/llama.cpp}"

# 界面上显示的机型名。留空 = 按实际硬件读（sysctl）。
# 想显示别的名字（例如演示用）就在这里覆盖，例：export MACHINE_NAME="Apple M5 Max"
export MACHINE_NAME="${MACHINE_NAME:-}"

# 指定具体模型（serve.sh 使用）。留空则在上面目录里自动搜索。
export MODEL_PATH="${MODEL_PATH:-}"
export MMPROJ_PATH="${MMPROJ_PATH:-}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# 挑选一个可用的 node
if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then
  :
elif [ -x /opt/homebrew/bin/node ]; then
  export NODE_BIN=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  export NODE_BIN=/usr/local/bin/node
else
  export NODE_BIN=node
fi

# ── 本机覆盖（此文件不纳入版本控制）─────────────────────────────
# 在这里可以覆写上面的任何变量，例如把 LLAMA_BIN 指向你自己的编译目录。
if [ -f "${DIR:-.}/config.local.sh" ]; then
  # shellcheck disable=SC1091
  . "${DIR:-.}/config.local.sh"
fi
