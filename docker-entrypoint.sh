#!/bin/sh
# 容器入口：把会话密钥注入环境变量后启动 Next。
#
# 为什么需要：middleware 跑在 Edge runtime，读不到 .session-secret 文件，
# 只能通过 env.SESSION_SECRET 拿到密钥来验签。没有它，中间件只能「看到 Cookie 就放行」，
# 于是任何无效/过期/其它实例留下的 Cookie 都会先渲染出完整页面骨架、再被 401 踢走（闪一下）。
#
# 优先级：外部显式设置的 SESSION_SECRET > <数据根目录>/.session-secret 文件 > 交给应用自己生成（退化）。
# 数据根目录与 app 侧一致：AI_EAT_DATA_DIR 指向 <data>/recipes，未设时用 /app/data。
set -e

DATA_ROOT="$(dirname "${AI_EAT_DATA_DIR:-/app/data/recipes}")"
if [ -z "${SESSION_SECRET:-}" ] && [ -f "${DATA_ROOT}/.session-secret" ]; then
  # 去掉末尾换行（node 侧 readFile 后 trim，保持一致）；不可读时不让容器启动失败，退化交给应用处理
  SESSION_SECRET="$(cat "${DATA_ROOT}/.session-secret" 2>/dev/null | tr -d '\r\n' || true)"
  export SESSION_SECRET
fi

exec "$@"
