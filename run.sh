#!/usr/bin/env bash
# AI-eat 裸机启动脚本：构建（增量）→ 后台启动 → 探测端口 → 打印局域网地址
# 用法：./run.sh [start|stop|restart|status]，PORT 环境变量可覆盖默认 8080
#
# 进程管理取舍：npm start 的孙进程会被 Next 改名为 "next-server (v…)"，按命令行 pkill -f
# "next start" 匹配不到，按 cwd 匹配 node 又会误伤同目录的 next dev 开发进程；
# 故用 setsid 独立会话 + PID 文件记录「进程组组长」，stop 时 kill 整个进程组，精确且无歧义
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8080}"
LOG_FILE="ai-eat.log"
PID_FILE=".ai-eat.pid"

# 取局域网 IPv4：hostname -I 首段（无外网也能拿到内网地址）
lan_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

# PID 文件中的进程组是否仍在运行（组长存活即视为运行中）
is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# 端口探测：等 node 服务端接受连接（最多 60 次 × 1s）
wait_port() {
  for _ in $(seq 1 60); do
    if node -e "const n=require('net');const s=n.connect(${PORT},'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),800)" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_server() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "未发现运行中的 AI-eat 进程"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  # 负号 = 杀整个进程组（setsid 使组长 PID 即 PGID，npm/sh/next-server 一并退出）
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 6); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "已停止"
}

start_server() {
  if is_running; then
    echo "AI-eat 已在运行（PID $(cat "$PID_FILE")，端口 ${PORT}），如需重启请用 ./run.sh restart"
    exit 0
  fi
  rm -f "$PID_FILE"
  # 端口被无关进程占用时及早失败，不产生误导性的启动日志
  if wait_port; then
    echo "端口 ${PORT} 已被其他进程占用，拒绝启动（可用 PORT=xxx ./run.sh 换端口）"
    exit 1
  fi

  # 取舍：已有 .next 产物则跳过构建（next start 直接复用），改动代码后用 ./run.sh restart
  # 触发 rebuild；每次启动都全量 build 会拖慢重启，单人自用不值得（上游裁定 8：保持简单）
  if [ ! -f .next/BUILD_ID ]; then
    echo "未检测到构建产物，开始构建（npm run build）……"
    npm run build
  fi

  echo "启动中：http://localhost:${PORT}（日志：${LOG_FILE}）"
  # setsid：脱离当前会话独立成组，组长 PID 写入 PID 文件，stop 按进程组收割
  PORT="${PORT}" nohup setsid npm start > "${LOG_FILE}" 2>&1 &
  echo $! > "$PID_FILE"

  if wait_port; then
    echo "启动成功"
    echo "本机访问: http://localhost:${PORT}"
    echo "局域网访问: http://$(lan_ip):${PORT}"
  else
    echo "启动失败：端口 ${PORT} 未就绪，请查看 ${LOG_FILE}"
    tail -n 30 "${LOG_FILE}" || true
    rm -f "$PID_FILE"
    exit 1
  fi
}

status_server() {
  if is_running; then
    echo "运行中：PID $(cat "$PID_FILE")"
    echo "本机访问: http://localhost:${PORT}"
    echo "局域网访问: http://$(lan_ip):${PORT}"
  else
    echo "未运行"
  fi
}

case "${1:-start}" in
  start)   start_server ;;
  stop)    stop_server ;;
  restart) stop_server; rm -rf .next; start_server ;;  # 重启触发重新构建，吃到代码更新
  status)  status_server ;;
  *) echo "用法：./run.sh [start|stop|restart|status]"; exit 1 ;;
esac
