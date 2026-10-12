#!/bin/sh
# 硬跑 DeepSeek-V4-Flash —— 专用启动脚本
#
# ⚠️ 为什么叫「硬跑」：模型 82.5 GB，可用内存约 40 GB。
#    能启动（mmap 只映射虚拟地址，不占物理内存），但权重会持续从 SSD 流式读取，
#    速度极慢（预估 0.1–0.7 tok/s），且 thrashing 会大量写 swap、磨损 SSD。
#
#    跑之前先在另一个终端开 ./watch-memory.sh 盯着。
#
# 用法：
#   ./serve-ds4.sh                              自动找模型
#   DS4_MODEL=/path/to/xxx.gguf ./serve-ds4.sh  指定模型
#   ./serve-ds4.sh stop
#   ./serve-ds4.sh status
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"

LOG="$APP_HOME/logs/serve-ds4.log"
# 刻意用 8081，不动原来的 8080 —— 两边可以共存，随时切回
PORT="${DS4_PORT:-8081}"

case "${1:-start}" in
  stop)
    PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
    if [ -n "$PIDS" ]; then
      echo "$PIDS" | xargs kill 2>/dev/null && echo "已停止（端口 ${PORT}）"
    else
      echo "未在运行"
    fi
    exit 0
    ;;
  status)
    if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
      echo "运行中（端口 ${PORT}）"
      sysctl vm.swapusage
    else
      echo "未运行"
    fi
    exit 0
    ;;
esac

MODEL="${DS4_MODEL:-}"
if [ -z "$MODEL" ]; then
  MODEL="$(find "$HOME/Documents/modle" -maxdepth 5 \
    \( -iname '*DeepSeek-V4-Flash*IQ1_S*-00001-of-*.gguf' \
       -o -iname '*DeepSeek-V4-Flash*UD-IQ1*.gguf' \) 2>/dev/null | head -1)"
fi

if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  echo "找不到 DS4-Flash 模型。下载（三个分片都要，共 82.5 GB）："
  echo
  echo "  B=https://hf-mirror.com/unsloth/DeepSeek-V4-Flash-0731-GGUF/resolve/main/UD-IQ1_S"
  echo "  curl -L -O \$B/DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf"
  echo "  curl -L -O \$B/DeepSeek-V4-Flash-0731-UD-IQ1_S-00002-of-00003.gguf"
  echo "  curl -L -O \$B/DeepSeek-V4-Flash-0731-UD-IQ1_S-00003-of-00003.gguf"
  echo
  echo "下完放进 ~/Documents/modle/ 下任意目录即可被自动发现，"
  echo "或用 DS4_MODEL=/路径/xxx.gguf ./serve-ds4.sh 指定。"
  exit 1
fi

if [ ! -x "$LLAMA_BIN/llama-server" ]; then
  echo "找不到 llama-server：$LLAMA_BIN/llama-server"; exit 1
fi

if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "端口 ${PORT} 已占用，先执行 ./serve-ds4.sh stop"; exit 1
fi

mkdir -p "$APP_HOME/logs"
cd "$LLAMA_BIN"

# 参数刻意保守 —— 目标是「别把机器搞死」，不是快：
#   -c 4096          最小上下文，KV 只占几百 MB，把内存全留给权重
#   -b 512 -ub 128   小 batch，避免 prefill 时申请大计算 buffer
#   -lm mmap         必须：权重按需从磁盘读（「硬跑」的来源就在这）
#   -np 1            单槽，不额外分 KV
echo "启动中（端口 ${PORT}，日志 ${LOG}）…"
echo "  模型：$MODEL"
echo "  大小：$(echo "scale=1; $(stat -f%z "$MODEL")/1000000000" | bc) GB（分片之一，全部 82.5 GB）"
echo
echo "  ⚠️ 另开一个终端跑 AUTO_STOP=1 ./watch-memory.sh —— swap 超 12 GB 会自动停服务。"
echo

nohup ./llama-server \
  -m "$MODEL" \
  -ngl 99 -c 4096 -np 1 \
  -lm mmap --lazy-mode on --jinja -fa on \
  -b 512 -ub 128 \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  --metrics \
  --host 127.0.0.1 --port "$PORT" \
  > "$LOG" 2>&1 &
disown

i=0
while [ "$i" -lt 100 ]; do
  if grep -q "listening on" "$LOG" 2>/dev/null; then
    echo "✓ 已就绪：http://127.0.0.1:${PORT}/v1"
    echo "  （首次请求会触发大量磁盘读，耐心等）"
    exit 0
  fi
  if grep -qE "error loading|failed to load|GGML_ASSERT" "$LOG" 2>/dev/null; then
    echo "✗ 加载失败："; tail -20 "$LOG"; exit 1
  fi
  sleep 3
  i=$((i + 1))
done

echo "…仍在加载（300 秒未就绪）。这符合预期 —— 82.5 GB 要读很久。"
echo "日志：tail -f ${LOG}"
