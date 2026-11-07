# LibreTV 局域网访问设计文档

> 源码基线：`~/tools/LibreTV`（v2.21.0）
> 文档范围：梳理 LibreTV 与局域网相关的两条访问路径——**局域网设备访问服务本身**与**服务反向访问局域网内资源（自建 IPTV）**，以及支撑这两条路径的安全设计。

---

## 1. 背景与问题定义

LibreTV 是纯无状态的聚合站：观看历史/进度在浏览器 IndexedDB，服务端不落任何盘。与"局域网"相关的问题实际是**方向相反的两件事**：

| 方向 | 场景 | 核心问题 |
| --- | --- | --- |
| **方向一：入** | 手机/电视盒子等局域网设备，通过 `http://<服务器IP>:8080` 访问服务 | 监听地址、纯 HTTP 下的会话（Cookie `Secure` 标记）、安全边界 |
| **方向二：出** | 部署在局域网内的服务器，访问内网自建 IPTV 源（udpxy 网关等） | SSRF 防护默认锁死内网，需要精确的放行开关 |

这两条路径由一个统一的安全模型串联：**默认按公网部署设计（锁死内网），需要内网资源时由部署者显式开门，且开门范围精确圈定到直播链路。**

---

## 2. 方向一：局域网设备访问服务

### 2.1 监听设计：绑定所有网卡

裸机部署与 Docker 部署路径不同，效果一致——监听所有接口，局域网设备无需任何额外配置即可访问。

**裸机部署（run.sh）**

启动命令是 `nohup npm start`（`run.sh:90`），即 `next start -p 8080`（`package.json:10`）。**没有传 `-H`/hostname 参数**：

```json
"start": "next start -p 8080",
```

Next.js 底层执行 `server.listen(port, hostname)`（`node_modules/next/dist/server/lib/start-server.js:268`），hostname 为 undefined 时 Node 默认监听 IPv6 双栈地址 `::`（等效包含 IPv4 所有接口）→ 局域网设备可直接访问。

启动成功后脚本主动探测并打印局域网地址（`run.sh:94-100`）：

```bash
if wait_port; then
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  info "启动成功 ✓"
  echo    "  本机访问:   http://localhost:${PORT}"
  [ -n "${ip:-}" ] && echo "  局域网访问: http://${ip}:${PORT}"
```

**Docker 部署**

两层保障：

- 镜像内显式声明 `ENV HOSTNAME=0.0.0.0`（`Dockerfile:20`）；
- compose 端口映射 `ports: "8080:8080"`（`docker-compose.yml:11-12`），Docker 默认将映射绑定到宿主机所有接口。

### 2.2 纯 HTTP 下的会话设计：Cookie `Secure` 标记自动推导

局域网访问的典型形态是 `http://192.168.x.x:8080`（无 TLS）。同类项目的常见故障是"密码正确却登不进去"——会话 Cookie 带 `Secure` 标记时，浏览器拒绝在 HTTP 连接上保存它。LibreTV 的解法是**不写死，按请求协议自动推导**。

Cookie 设置（`src/app/api/auth/route.ts:44-50`）：

```ts
res.cookies.set(SESSION_COOKIE, token, {
  httpOnly: true, sameSite: 'lax', secure, maxAge: ..., path: '/',
});
```

`secure` 的推导逻辑（该文件 `:37-43` 处注释自述设计动机）：

- `COOKIE_SECURE` 环境变量可显式覆盖（`true` 强制开 / `false` 强制关）；
- 未设置时按 `x-forwarded-proto` 首段推导；
- 关键实现细节：**不能依赖 `req.url` 判断协议**——Next.js Route Handler 中它是内部转发地址，并非用户侧的原始协议。

README 对该行为的对外承诺（`README.md:70`）：

> 登录本身**不依赖 HTTPS**：会话 cookie 的 `Secure` 标记按请求协议（`x-forwarded-proto`）自动推导，`http://服务器IP:端口` 也能正常登录，不会再出现"密码正确却无法登录"。需要强制指定时用 `COOKIE_SECURE`。

### 2.3 局域网客户端的架构红利：所有上游访问收敛到服务端

客户端不直接访问任何采集站/豆瓣/IPTV 源，全部上游请求收敛到同源代理：

| 链路 | 端点 |
| --- | --- |
| 聚合搜索 | `POST /api/search`（可选 NDJSON 流式） |
| 详情 | `GET /api/detail` |
| 封面/分片代理 | `GET /api/proxy?url=` |
| 直播拉流 | `GET /api/live/stream?url=`（长连接） |
| M3U/EPG 拉取 | `GET /api/live/playlist`、`/api/live/epg` |

这带来一个对局域网场景友好的性质：**弱终端（老电视盒子、低配手机）只需连通服务器 IP 一个地址**，上游源的连通性、CORS、混合内容问题全部由服务器统一承担。同源 httpOnly Cookie 自动携带完成鉴权，客户端不持有任何可重放凭证（`README.md:255`）。

### 2.4 安全代价与取舍

无 TLS 的局域网 HTTP 意味着登录密码在 POST body 中明文传输。README 明确提示（`README.md:69`）：

> 💡 **对外提供服务建议套上 HTTPS**：登录密码在 POST body 中以明文传输，公网 HTTP 会被中间人看到，推荐用反向代理（Nginx / Caddy / Traefik）或 Cloudflare 终结 TLS。

取舍逻辑：局域网内中间人风险可控（信任边界是家庭/办公路由器），换取"IP 直连零配置可用"；一旦暴露公网，部署者必须自行套反代终结 TLS。

---

## 3. 方向二：服务访问局域网内资源（自建 IPTV）

### 3.1 问题：SSRF 防护与内网源的天然冲突

服务端代理（`/api/proxy`、`/api/live/stream`、`/api/live/playlist` 等）本身就是 SSRF 攻击面：攻击者可借服务器的网络位置探测部署者内网。因此默认策略是**所有内网/保留地址一律拒绝**：

- 私网段清单覆盖回环、`10.`、`192.168.`、`172.16-31.`、`169.254.`（含云元数据 `169.254.169.254`）、CGNAT `100.64.`、ULA `fc|fd`、链路本地 `fe80:`（`src/lib/ssrf.ts:24-35`）；
- IPv4-mapped IPv6 先归一化再判定（`ssrf.ts:13-21`）；
- DNS 解析后校验：`dns.lookup(hostname, { all: true })`，**任一解析结果命中私网即拒绝**（`ssrf.ts:63`）；
- 重定向逐跳重校验：`redirect: 'manual'` + 每一跳重新过 SSRF，防"预检通过后 3xx 把请求带进内网"（`src/lib/fetch-utils.ts:62-68`）。

但局域网自建 IPTV 是真实需求：家庭网络里的 udpxy 网关（`http://192.168.1.x:8080/udp/239.x.x.x:5000`）、内网 DVR/软媒体的 HLS 服务都在私网段。**默认策略会把这类合法场景全部拦掉。**

### 3.2 设计：精确到直播链路的显式开关

开关读取（`src/lib/ssrf.ts:88-90`）：

```ts
process.env.LIVE_ALLOW_PRIVATE === '1'
```

放行逻辑（`ssrf.ts:99-110` `checkLiveUrlAllowed`）：

```ts
if (allowLivePrivate()) return { ok: true };
```

即开启后**直接跳过全部私网检查**（仅保留 http(s) 协议校验）。生效范围经过精确圈定，不是全局放行：

| 链路 | 受开关影响 | 说明 |
| --- | --- | --- |
| 直播：拉 M3U 列表 | ✅ 放行内网 | `/api/live/playlist` |
| 直播：EPG 节目单 | ✅ 放行内网 | `/api/live/epg` |
| 直播：批量测活 | ✅ 放行内网 | `/api/live/probe` |
| 直播：拉流代理 | ✅ 放行内网 | `/api/live/stream` |
| **点播：搜索/详情/画质探测** | ❌ 一律仍拒内网 | `search` / `detail` / `quality` / `source-list` 不受开关影响 |

compose 注释明确圈定范围（`docker-compose.yml:30`）：

```yaml
# 可选：自建内网 IPTV 放行（对拉列表、测活、拉流三个阶段同时生效，默认关闭以维持 SSRF 防护）
# - LIVE_ALLOW_PRIVATE=1
```

**为什么只开直播这一扇门**：内网合法场景（IPTV 网关）只存在于直播链路；点播源没有"必须部署在内网"的合理形态，全部保持 SSRF 防护可最小化公网实例被借道探测内网的攻击面。

### 3.3 直播拉流代理与局域网长连接的匹配

内网 IPTV 拉流走 `/api/live/stream`，该代理的超时模型专门为"无限长连接流"设计，与普通代理不同（`src/lib/proxy-handlers.ts`）：

| 维度 | 普通代理 | 直播代理 |
| --- | --- | --- |
| 超时模型 | 整个响应流 8s 超时 | **仅对响应头等待限时 15s**，拿到响应头即清计时器，body 不再受限 |
| 重试 | `MAX_RETRIES` 次 | 不重试（对直播无意义） |
| 连接生命周期 | 超时切断 | 无限时长透传，直到客户端断开（`req.signal` abort 链入上游 controller 防连接泄漏） |

代码注释直接点明动机（`proxy-handlers.ts:158-159`）：

> 对 HTTP-FLV（单一无限长连接）是致命的

即：若对整个 body 施加 8s 限时，局域网 FLV 直播流会在 8 秒后被服务器主动掐断——这是直播代理必须独立于普通代理存在的原因。

### 3.4 硬边界：组播原始流无法进入

内网 IPTV 的原始形态常是组播地址（`rtp://239.x.x.x:5000` / `udp://@...`），但**浏览器无法播放这些协议**，M3U 解析阶段直接丢弃（`src/lib/m3u-parser.ts:12` 注释原文）：

```
 * （rtp:// udp:// rtsp:// 等浏览器无法播放的协议直接丢弃）。
```

单测同样锁定该行为（`m3u-parser.test.ts:12-14`）：

```ts
expect(normalizeStreamUrl('rtp://239.1.1.1:5000')).toBeUndefined();
expect(normalizeStreamUrl('udp://@239.1.1.1:5000')).toBeUndefined();
expect(normalizeStreamUrl('rtsp://cam.local/stream')).toBeUndefined();
```

因此内网 IPTV 实际可用的形态是**经 udpxy 之类的组播网关转成 HTTP 后的 HLS / HTTP-FLV 流**，再由直播代理透传。

---

## 4. 统一安全模型

两条方向合起来构成自洽的设计：

```
                    ┌──────────────────────────────┐
   方向一（入）       │  默认面向公网部署设计            │      方向二（出）
局域网设备 ────────► │  · 监听所有网卡（0.0.0.0/::）    │ ────────► 公网采集站/豆瓣/…
 http://IP:8080     │  · Cookie Secure 按协议推导      │           （SSRF 全程防护）
                    │  · 客户端只触达服务器一个地址      │
                    └──────────┬───────────────────┘
                               │ LIVE_ALLOW_PRIVATE=1
                               ▼ （仅直播链路开门）
                        内网 IPTV 源（udpxy 等）
```

核心原则：

1. **默认态锁死内网**：服务端一切出站代理默认拒绝私网/保留地址，公网部署不被借道探测内网；
2. **开门须显式**：内网 IPTV 需部署者主动设置 `LIVE_ALLOW_PRIVATE=1`，且开关精确圈定到直播四个阶段，点播侧不受影响；
3. **入站零配置、出站显式开门**：局域网设备访问服务不需要任何配置（含纯 HTTP 登录），但服务访问内网资源必须显式授权；
4. **浏览器能力即边界**：`rtp://`/`udp://`/`rtsp://` 组播流因浏览器不支持而在解析层丢弃，不做任何"尽力转发"的伪支持。

---

## 5. 部署速查

### 5.1 局域网设备访问（零配置）

```bash
# 裸机（run.sh）
./run.sh start          # 启动后自动打印局域网地址

# Docker
PASSWORD=your-password docker compose up -d
```

局域网设备浏览器打开 `http://<服务器局域网IP>:8080`，输入 `PASSWORD` 登录即可。纯 HTTP 下登录正常（Cookie 不带 `Secure`）。

### 5.2 播放内网 IPTV 源

前提：内网源必须是 **HTTP-FLV / HLS** 形态（组播原始流需先经 udpxy 等网关转 http）。

`docker-compose.yml` 环境变量：

```yaml
environment:
  - LIVE_ALLOW_PRIVATE=1    # 放行直播链路访问内网（拉列表/EPG/测活/拉流）
```

随后在「设置 → 源管理 → 直播源」填入内网 M3U 地址（如 `http://192.168.1.x/iptv/list.m3u`）。

### 5.3 注意事项

- `LIVE_ALLOW_PRIVATE=1` 开启后，**任何能登录站点的人都可以借服务器访问内网 HTTP 资源**（限于直播四端点）。公网部署的实例不建议开启；该开关面向"整体部署在内网"的场景；
- 若套了反代终结 TLS 但反代未传 `x-forwarded-proto`，Cookie 不会带 `Secure`（不影响登录，少了这层保护），可设 `COOKIE_SECURE=true` 强制；
- 限速按 `x-forwarded-for` 首段识别 IP，局域网内多设备经同一网关出口时共享 10 次/10 分钟的登录限额。
