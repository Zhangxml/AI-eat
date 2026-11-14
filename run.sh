#!/usr/bin/env bash
# AI-eat 裸机启动脚本：构建（增量）→ 后台启动 → 探测端口 → 打印局域网地址
# 用法：./run.sh [start|stop|restart|status]，PORT 环境变量可覆盖默认 8888
#
# 进程管理取舍：npm start 的孙进程会被 Next 改名为 "next-server (v…)"，按命令行 pkill -f
# "next start" 匹配不到，按 cwd 匹配 node 又会误伤同目录的 next dev 开发进程；
# 故用 setsid 独立会话 + PID 文件记录「进程组组长」，stop 时 kill 整个进程组，精确且无歧义
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8888}"
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

# 端口就绪等待：等 node 服务端接受连接（最多 60 次 × 1s）——启动后的就绪等待用
wait_port() {
  for _ in $(seq 1 60); do
    if node -e "const n=require('net');const s=n.connect(${PORT},'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),800)" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# 端口占用预检：单次探测（审计修复 #10）——启动前检查端口是否已被监听。
# 不复用 wait_port：循环等待最长 60 秒，仅适合「等服务起来」；预检要的是即时结论，
# 端口空闲立即失败、被占用立即拒绝启动
port_in_use() {
  node -e "const n=require('net');const s=n.connect(${PORT},'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),800)" 2>/dev/null
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
  # 端口被无关进程占用时及早失败，不产生误导性的启动日志（单次探测，见 port_in_use）
  if port_in_use; then
    echo "端口 ${PORT} 已被其他进程占用，拒绝启动（可用 PORT=xxx ./run.sh 换端口）"
    exit 1
  fi

  # 取舍：已有 .next 产物则跳过构建（next start 直接复用），改动代码后用 ./run.sh restart
  # 触发 rebuild；每次启动都全量 build 会拖慢重启，单人自用不值得（上游裁定 8：保持简单）
  if [ ! -f .next/BUILD_ID ]; then
    echo "未检测到构建产物，开始构建（npm run build）……"
    npm run build
  fi

  # 把会话密钥注入环境变量：middleware（Edge runtime）读不到 .session-secret 文件，
  # 只能通过 env 拿到密钥来验签。没有它，middleware 只能「看到 Cookie 就放行」——
  # 那样任何无效/过期/来自其它实例的 Cookie 都会先渲染出完整页面骨架、再被 401 踢走（闪一下）。
  # 优先级：已在环境里显式设置的 SESSION_SECRET > <数据根目录>/.session-secret 文件 > 交给服务自己生成。
  # 数据根目录与 app 侧一致：AI_EAT_DATA_DIR 指向 <data>/recipes，未设时用 ./data。
  DATA_ROOT="$(dirname "${AI_EAT_DATA_DIR:-data/recipes}")"
  if [ -z "${SESSION_SECRET:-}" ] && [ -f "${DATA_ROOT}/.session-secret" ]; then
    # 去掉文件末尾换行（node 侧 readFile 后 trim，这里保持一致，避免两侧密钥不同导致全员重登）
    # 2>/dev/null || true：文件存在但不可读时不因 set -e 中断启动（退化交给服务自己处理）
    SESSION_SECRET="$(cat "${DATA_ROOT}/.session-secret" 2>/dev/null | tr -d '\r\n' || true)"
  fi
  if [ -n "${SESSION_SECRET:-}" ]; then
    export SESSION_SECRET
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
