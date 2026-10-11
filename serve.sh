#!/bin/sh
# 直接启动 llama-server（不经过控制台界面）
#
# 用法：
#   ./serve.sh            自动发现模型并启动
#   ./serve.sh stop       停止
#   ./serve.sh status     查看状态
#
# 指定模型（可选）：
#   STRATA_MODEL=/path/to/xxx-00001-of-00002.gguf ./serve.sh
#   STRATA_MMPROJ=/path/to/mmproj-xxx.gguf ./serve.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"

LOG="$STRATA_HOME/logs/serve.log"

# ── 定位模型：优先 STRATA_MODEL，否则在 STRATA_MODEL_DIR 各目录里搜索 ──
find_model() {
  for _d in $(echo "$STRATA_MODEL_DIR" | tr ':' ' '); do
    [ -d "$_d" ] || continue
    _f="$(find "$_d" -name '*-00001-of-*.gguf' ! -name 'mmproj*' 2>/dev/null | head -1)"
    if [ -z "$_f" ]; then
      _f="$(find "$_d" -maxdepth 3 -name '*.gguf' ! -name 'mmproj*' 2>/dev/null | head -1)"
    fi
    if [ -n "$_f" ]; then echo "$_f"; return 0; fi
  done
  return 1
}

case "${1:-start}" in
  stop)
    PIDS="$(lsof -ti tcp:"$SERVE_PORT" 2>/dev/null || true)"
    if [ -n "$PIDS" ]; then
      echo "$PIDS" | xargs kill 2>/dev/null && echo "已停止 llama-server（端口 ${SERVE_PORT}）"
    else
      echo "llama-server 未在运行"
    fi
    exit 0
    ;;
  status)
    if lsof -ti tcp:"$SERVE_PORT" >/dev/null 2>&1; then
      echo "llama-server 运行中（端口 ${SERVE_PORT}）"
      curl -s -m 5 --noproxy '*' "http://127.0.0.1:$SERVE_PORT/props" \
        | sed -n 's/.*"n_ctx":\([0-9]*\).*/  上下文: \1/p' || true
    else
      echo "llama-server 未运行"
    fi
    exit 0
    ;;
esac

MODEL="${STRATA_MODEL:-}"
if [ -z "$MODEL" ]; then
  MODEL="$(find_model || true)"
fi

if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  echo "找不到模型。请设置 STRATA_MODEL，或把 GGUF 放进以下任一目录："
  echo "$STRATA_MODEL_DIR" | tr ':' '\n' | sed 's/^/  /'
  exit 1
fi

# mmproj（视觉投影器）：优先环境变量，否则找模型同目录下的 mmproj*.gguf
MMPROJ="${STRATA_MMPROJ:-}"
if [ -z "$MMPROJ" ]; then
  MMPROJ="$(find "$(dirname "$MODEL")" -maxdepth 1 -name 'mmproj*.gguf' 2>/dev/null | head -1)"
fi

if [ ! -x "$LLAMA_BIN/llama-server" ]; then
  echo "找不到 llama-server：$LLAMA_BIN/llama-server"
  echo "请先编译 llama.cpp，或用 LLAMA_BIN 指定其 bin 目录。"
  exit 1
fi

if lsof -ti tcp:"$SERVE_PORT" >/dev/null 2>&1; then
  echo "端口 ${SERVE_PORT} 已被占用，先执行 ./serve.sh stop"
  exit 1
fi

mkdir -p "$STRATA_HOME/logs"
cd "$LLAMA_BIN"

# 内存账（48GB 统一内存机型）：
#   权重 35.9GB + KV(q4_0@65536) ~3GB + 系统 ~8GB ≈ 47GB
# 上下文 65536 是为了容纳大型客户端（系统提示词 + 工具描述 + 历史）约 50K token 的请求；
# KV 用 q4_0 而非 q8_0 是 48GB 下的内存所迫 —— 显存/内存更宽裕的机器可用 q8_0 或 f16。
#
# 缓存策略：只用内存 KV 缓存（llama-server 默认行为）。
# 刻意不加 --prompt-cache / --slot-save-path —— 那两个会把对话状态写到磁盘并长期占用空间。

MM_ARG=""
if [ -n "$MMPROJ" ] && [ -f "$MMPROJ" ]; then
  MM_ARG="--mmproj $MMPROJ"
fi

# shellcheck disable=SC2086
nohup ./llama-server \
  -m "$MODEL" $MM_ARG \
  -ngl 99 -c 65536 -np 1 \
  -lm mmap --lazy-mode on --jinja -fa on \
  -b 4096 -ub 1024 \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  --metrics \
  --host 127.0.0.1 --port "$SERVE_PORT" \
  > "$LOG" 2>&1 &
disown

echo "启动中（日志：${LOG}）…"
echo "  模型：$MODEL"
[ -n "$MM_ARG" ] && echo "  视觉：$MMPROJ"

i=0
while [ "$i" -lt 60 ]; do
  if grep -q "listening on" "$LOG" 2>/dev/null; then
    echo "✓ 就绪：http://127.0.0.1:${SERVE_PORT}/v1"
    exit 0
  fi
  sleep 3
  i=$((i + 1))
done

echo "✗ 启动超时，看日志：$LOG"
tail -20 "$LOG"
exit 1
