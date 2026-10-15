#!/bin/sh
# 直接启动 llama-server（不经过控制台界面）
#
# 用法：
#   ./serve.sh            自动发现模型并启动
#   ./serve.sh stop       停止
#   ./serve.sh status     查看状态
#
# 指定模型（可选）：
#   MODEL_PATH=/path/to/xxx-00001-of-00002.gguf ./serve.sh
#   MMPROJ_PATH=/path/to/mmproj-xxx.gguf ./serve.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"

LOG="$APP_HOME/logs/serve.log"

# ── 定位模型：优先 MODEL_PATH，否则在 MODEL_DIRS 各目录里搜索 ──
find_model() {
  for _d in $(echo "$MODEL_DIRS" | tr ':' ' '); do
    [ -d "$_d" ] || continue
    _f="$(find "$_d" -name '*-00001-of-*.gguf' ! -name 'mmproj*' 2>/dev/null | head -1)"
    if [ -z "$_f" ]; then
      _f="$(find "$_d" -maxdepth 3 -name '*.gguf' ! -name 'mmproj*' 2>/dev/null | head -1)"
    fi
    if [ -n "$_f" ]; then echo "$_f"; return 0; fi
  done
  return 1
}

# runconfig.json 里若指定了 port，stop / status 也要认（必须在 case 之前读）
if [ -f "$DIR/runconfig.json" ]; then
  _p="$("$NODE_BIN" -e 'try{const d=require(process.argv[1]);if(d.port)process.stdout.write(String(d.port))}catch(e){}' "$DIR/runconfig.json" 2>/dev/null)"
  [ -n "$_p" ] && SERVE_PORT="$_p"
fi

case "${1:-start}" in
  stop)
    PIDS="$(lsof -nP -iTCP:"$SERVE_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$PIDS" ]; then
      echo "$PIDS" | xargs kill 2>/dev/null && echo "已停止 llama-server（端口 ${SERVE_PORT}）"
    else
      echo "llama-server 未在运行"
    fi
    exit 0
    ;;
  status)
    if lsof -nP -iTCP:"$SERVE_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "llama-server 运行中（端口 ${SERVE_PORT}）"
      curl -s -m 5 --noproxy '*' "http://127.0.0.1:$SERVE_PORT/props" \
        | sed -n 's/.*"n_ctx":\([0-9]*\).*/  上下文: \1/p' || true
    else
      echo "llama-server 未运行"
    fi
    exit 0
    ;;
esac

MODEL="${MODEL_PATH:-}"
if [ -z "$MODEL" ]; then
  MODEL="$(find_model || true)"
fi

if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  echo "找不到模型。请设置 MODEL_PATH，或把 GGUF 放进以下任一目录："
  echo "$MODEL_DIRS" | tr ':' '\n' | sed 's/^/  /'
  exit 1
fi

# mmproj（视觉投影器）：优先环境变量，否则找模型同目录下的 mmproj*.gguf
MMPROJ="${MMPROJ_PATH:-}"
if [ -z "$MMPROJ" ]; then
  MMPROJ="$(find "$(dirname "$MODEL")" -maxdepth 1 -name 'mmproj*.gguf' 2>/dev/null | head -1)"
fi

if [ ! -x "$LLAMA_BIN/llama-server" ]; then
  echo "找不到 llama-server：$LLAMA_BIN/llama-server"
  echo "请先编译 llama.cpp，或用 LLAMA_BIN 指定其 bin 目录。"
  exit 1
fi

if lsof -nP -iTCP:"$SERVE_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "端口 ${SERVE_PORT} 已被占用，先执行 ./serve.sh stop"
  exit 1
fi

mkdir -p "$APP_HOME/logs"
cd "$LLAMA_BIN"

# ── 参数：优先用控制台界面（Strata UI 的 Model settings）保存的 runconfig.json ──
RC="$DIR/runconfig.json"
if [ -f "$RC" ]; then
  eval "$("$NODE_BIN" -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const [k, v] of Object.entries(d)) {
        if (v === null || v === undefined || v === "") continue;
        const name = k.toUpperCase();
        const val = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
        console.log(name + "=\"" + val + "\"");
      }
    } catch (e) {}
  ' "$RC" 2>/dev/null)"
fi

# 默认值（runconfig.json 没给的项用这些）
# 内存账（48GB 统一内存机型，实测）：
#   权重 ~35.9GB + KV(q4_0@262144) ~1.8GB + SSM 状态 ~0.2GB + 系统 ~8GB ≈ 46GB
#
# 为什么 256K 上下文只吃 ~1.8GB KV：
#   该模型是混合注意力架构（qwen4exp）—— 48 层里每 4 层才 1 层全注意力
#   （full_attention_interval=4 → 仅 12 层占 KV），且 KV head 只有 2 个、head_dim 256。
#   精确值 = 2(K+V) × 12层 × 2头 × 256 × 262144 × 0.5625B(q4_0) ≈ 1.81GB。
#   其余 36 层是线性注意力（SSM），状态固定大小、不随上下文增长。
#   模型原生 context_length=262144（rope.freq_base=1e7），无需额外缩放参数。
#
# 缓存策略：只用内存 KV 缓存（llama-server 默认行为）。
# 刻意不加 --prompt-cache / --slot-save-path —— 那两个会把对话状态写到磁盘并长期占用空间。
: "${CTX:=262144}"
: "${NGL:=99}"
: "${NP:=1}"
: "${KV_TYPE:=q4_0}"
: "${BATCH:=4096}"
: "${UBATCH:=1024}"
: "${FA:=1}"
# POLL：CPU 忙等轮询等级（0-100）。实测在 32K 上下文下 100 比默认 50 快约 5%，
# 但在 256K 下无收益、且会拖慢 prefill（此时内存压力才是主瓶颈），故默认留空交给 llama.cpp。
: "${POLL:=}"
: "${LAZY:=1}"
: "${JINJA:=1}"
: "${PORT:=$SERVE_PORT}"
SERVE_PORT="$PORT"

MM_ARG=""
if [ -n "$MMPROJ" ] && [ -f "$MMPROJ" ]; then
  MM_ARG="--mmproj $MMPROJ"
fi
FA_ARG="";     [ "$FA" = "1" ]    && FA_ARG="-fa on"
POLL_ARG="";   [ -n "$POLL" ] && [ "$POLL" != "0" ] && POLL_ARG="--poll $POLL"
LAZY_ARG="";   [ "$LAZY" = "1" ]  && LAZY_ARG="-lm mmap --lazy-mode on"
JINJA_ARG="";  [ "$JINJA" = "1" ] && JINJA_ARG="--jinja"
KV_ARG=""
if [ -n "$KV_TYPE" ] && [ "$KV_TYPE" != "f16" ]; then
  KV_ARG="--cache-type-k $KV_TYPE --cache-type-v $KV_TYPE"
fi

# shellcheck disable=SC2086
nohup ./llama-server \
  -m "$MODEL" $MM_ARG \
  -ngl "$NGL" -c "$CTX" -np "$NP" \
  $LAZY_ARG $JINJA_ARG $FA_ARG $POLL_ARG \
  -b "$BATCH" -ub "$UBATCH" \
  $KV_ARG \
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
