#!/bin/sh
# 硬跑大模型时的安全绳 —— 盯着内存与 swap
#
# thrashing 的特征是 swap 快速增长。两种应对：
#   手动：看到「⚠️」就 Ctrl-C，然后 ./serve-ds4.sh stop
#   自动：AUTO_STOP=1 ./watch-memory.sh
#         swap 累计超过 STOP_MB（默认 12288 = 12 GB）就自动停掉 llama-server
#
#   ./watch-memory.sh            只报警，不动手
#   AUTO_STOP=1 ./watch-memory.sh   报警并自动停止
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/env.sh"

PORT="${DS4_PORT:-8081}"
WARN_MB="${WARN_MB:-200}"     # 单次采样（2 秒）swap 增长超过这个值就报警
STOP_MB="${STOP_MB:-12288}"   # swap 累计超过这个值就自动停服务
AUTO_STOP="${AUTO_STOP:-0}"   # 1 = 到线自动 kill
PAGE=16384

free_gb() {
  vm_stat | /Users/jinweizhang/.workbuddy-ai/binaries/python/versions/3.13.12/bin/python3 -c "
import sys
v={}
for l in sys.stdin:
    if ':' in l:
        k,val=l.split(':',1); val=val.strip().rstrip('.')
        if val.isdigit(): v[k.strip()]=int(val)
p=$PAGE
f=(v.get('Pages free',0)+v.get('Pages inactive',0)+v.get('Pages speculative',0))*p
print(f'{f/1e9:.1f}')
" 2>/dev/null || echo "?"
}

echo "监控中（端口 ${PORT}）—— 每 2 秒采样，swap 单次增长 > ${WARN_MB} MB 就报警"
echo "Ctrl-C 退出。"
echo
printf "%-10s %-14s %-12s %-12s %s\n" "时间" "swap 已用" "增长/2s" "可用内存" "状态"
printf "%-10s %-14s %-12s %-12s %s\n" "──────" "──────────" "────────" "────────" "────"

PREV=0
FIRST=1
while true; do
  NOW=$(date +%H:%M:%S)
  SW=$(sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p')
  SW=${SW:-0}
  SW_INT=${SW%.*}
  FREE=$(free_gb)

  if [ "$FIRST" = "1" ]; then
    DELTA=0; FIRST=0
  else
    DELTA=$((SW_INT - PREV))
  fi
  PREV=$SW_INT

  if [ "$AUTO_STOP" = "1" ] && [ "$SW_INT" -gt "$STOP_MB" ]; then
    printf "%-10s %-11s MB %-9s MB %-9s GB " "$NOW" "$SW_INT" "$DELTA" "$FREE"
    echo "🛑 超过止损线 ${STOP_MB} MB —— 自动停止服务"
    lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
    exit 0
  fi

  if [ "$DELTA" -gt "$WARN_MB" ]; then
    STATE="⚠️  正在 thrashing —— 建议立刻停止"
  elif [ "$DELTA" -gt 50 ]; then
    STATE="注意：swap 在涨"
  else
    STATE="正常"
  fi

  printf "%-10s %-11s MB %-9s MB %-9s GB %s\n" "$NOW" "$SW_INT" "$DELTA" "$FREE" "$STATE"
  sleep 2
done
