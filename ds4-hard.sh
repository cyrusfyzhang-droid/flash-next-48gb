#!/bin/sh
# DS4-Flash 硬跑脚本（48GB 统一内存机型专用）
#
# ⚠️  冒烟测试用，非常规部署
# ⚠️  82.5 GB 模型 > 约 40 GB 可用内存，mmap 后会发生剧烈 thrashing：
#      · 速度 0.1–0.7 tok/s（对比正常部署的 32 tok/s）
#      · 页被反复换出 swapfile，估算 1.8 TB/小时写入
#      · Apple 1TB SSD 的 TBW 业界估算约 600 TB → 连续跑约 300 小时耗尽
#      · 系统会明显卡顿，最坏可能内核 panic
#
# 强烈建议：
#   1. 把模型放到外置 SSD 上，别烧内置盘
#   2. 先备份重要数据
#   3. 跑的时候不要指望机器还能干别的事
#
# 止损逻辑：本脚本持续监控 swap 使用量，超过 SWAP_LIMIT_MB 就自动停止服务。
#
# 模型下载（自选，二选一）：
#   unsloth UD-IQ1_S  82.5 GB（3 分片，1.75-bit，质量损失小）
#     https://hf-mirror.com/unsloth/DeepSeek-V4-Flash-0731-GGUF/resolve/main/UD-IQ1_S/
#   unsloth UD-TQ1_0  ~78 GB（更激进，1.58-bit）
#
# 用法：
#   ./ds4-hard.sh             启动并监控
#   ./ds4-hard.sh stop        停止服务与监控
#   ./ds4-hard.sh status      只看当前状态

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"

LOG="$APP_HOME/logs/ds4.log"
MON="$APP_HOME/run/ds4-monitor.pid"
PORT="${SERVE_PORT:-8080}"
SWAP_LIMIT_MB="${SWAP_LIMIT_MB:-12288}"    # swap 超过 12 GB 自动停
CTX="${DS4_CTX:-8192}"                     # 上下文压到最小，省 KV 内存

case "${1:-start}" in
  stop)
    P="$(cat "$MON" 2>/dev/null || true)"
    [ -n "$P" ] && kill "$P" 2>/dev/null && echo "  监控已停"
    rm -f "$MON"
    lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null && echo "  llama-server 已停"
    exit 0
    ;;
  status)
    sysctl vm.swapusage 2>/dev/null
    echo "  llama-server: $(lsof -ti tcp:"$PORT" 2>/dev/null | head -1 || echo 未运行)"
    exit 0
    ;;
esac

# ── 定位 DS4-Flash 的 GGUF 分片 ──
MODEL="${MODEL_PATH:-}"
if [ -z "$MODEL" ]; then
  echo "请设置 MODEL_PATH 指向 DS4-Flash 的 00001-of-000XX.gguf 分片，例如："
  echo "  或者放到 ~/Documents/models/ 下让脚本自动找。"
  exit 1
fi
[ -f "$MODEL" ] || { echo "找不到模型文件：$MODEL"; exit 1; }

if [ ! -x "$LLAMA_BIN/llama-server" ]; then
  echo "找不到 llama-server：$LLAMA_BIN/llama-server"
  exit 1
fi

if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "端口 ${PORT} 已被占用，先 ./ds4-hard.sh stop"
  exit 1
fi

mkdir -p "$APP_HOME/logs" "$APP_HOME/run"
cd "$LLAMA_BIN"

echo "════ 启动 DS4-Flash（上下文 ${CTX}）════"
nohup ./llama-server \
  -m "$MODEL" \
  -ngl 99 -c "$CTX" -np 1 \
  -lm mmap --lazy-mode on --jinja -fa on \
  -b 2048 -ub 512 \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  --metrics \
  --host 127.0.0.1 --port "$PORT" \
  > "$LOG" 2>&1 &
disown

# 等加载完成
i=0
while [ "$i" -lt 90 ]; do
  grep -q "listening on" "$LOG" 2>/dev/null && break
  sleep 5
  i=$((i + 1))
done

if ! grep -q "listening on" "$LOG" 2>/dev/null; then
  echo "✗ 启动超时，看日志：$LOG"
  tail -20 "$LOG"
  exit 1
fi
echo "  ✓ 就绪 http://127.0.0.1:${PORT}/v1"
echo "  ✓ 日志 $LOG"

# ── 监控循环：swap 超过阈值就自动停 ──
(
  while true; do
    USED=$(sysctl -n vm.swapusage 2>/dev/null \
           | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p')
    WIRED=$(vm_stat | grep -m1 "Pages wired down" | sed 's/[^0-9]//g')
    if [ -n "$USED" ]; then
      printf '\r  [%s] swap 已用 %s MB / 上限 %s MB   wired %s 页   ' \
        "$(date +%H:%M:%S)" "$USED" "$SWAP_LIMIT_MB" "$WIRED"
      if [ "$(echo "$USED" | cut -d. -f1)" -gt "$SWAP_LIMIT_MB" ]; then
        echo ""
        echo "  ⚠️  swap 超过 ${SWAP_LIMIT_MB} MB —— 正在自动停止服务以保护 SSD"
        lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
        break
      fi
    fi
    sleep 5
  done
  echo "  监控结束"
) &
echo $! > "$MON"
echo "  ✓ 监控已启动（PID $(cat "$MON")）— ./ds4-hard.sh stop 停止"
