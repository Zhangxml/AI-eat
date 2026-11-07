# 模块：AI 对话（聊天页 + /api/ai/chat）

> 代码位置：`src/app/api/ai/chat/route.ts`（SSE 服务端）、`src/lib/sse.ts`（事件编码）、
> `src/lib/sse-client.ts`（前端解析）、`src/components/ChatView.tsx`（聊天 UI）、`src/lib/chat-history.ts`（组包）
> 消费方：首页 `/`（问问AI）

## 做什么

应用的主入口：一个对话式界面，用户用自然语言说需求（「冰箱有番茄和鸡蛋」「想吃清淡的」），AI 流式回答；回答中若包含菜谱，自动解析为结构化卡片并支持**一键入库**到菜谱库。

## 怎么做的

### SSE 事件协议（前后端契约，一字不差）

```
event: message   data: {"t":"<正文增量>"}          ← <recipe> 标签出现前的流式文本
event: recipe    data: <完整 Recipe JSON>          ← 标签闭合后解析成功（id/时间戳已覆写）
event: error     data: {"error":"<中文>"}          ← 解析两次失败/上游异常
event: done      data: {}                          ← 收尾（error 之后照常发，不中断流）
```

### 服务端处理管线（chat/route.ts）

```
POST { messages } ──► 400 校验（messages 非空数组）
                  ──► 503 AI 未配置（loadAiConfig 真实路径）
                  ──► 注入库摘要系统消息 → aiChatStream 调上游
                  ──► 手动泵逐行读上游 SSE（OpenAI delta 格式，跨 chunk 半行缓冲）
                       │
                       ├─ RecipeStreamSplitter 状态机：
                       │   <recipe> 前增量 → message 事件（半截标签如 <rec 跨增量扣留不泄漏）
                       │   标签间内容缓冲不外发
                       │   </recipe> 闭合 → extractRecipeJson
                       │        ├─ 成功 → recipe 事件（无条件覆写 id/时间戳/source）
                       │        └─ 失败 → aiComplete 重试一次 → 仍失败 → error 事件
                       └─ 上游 [DONE] → done 事件收尾
客户端断开（request.signal）→ reader.cancel()，不留悬挂连接
```

### 前端（ChatView + sse-client）

- `readSse(res, onEvent)`：按空行分帧、`event:` 行定类型（缺省 message）、`data:` JSON 解析后分发；TextDecoder stream 模式处理跨 chunk 多字节汉字
- 消息渲染：message 增量拼进当前 assistant 气泡并自动滚底；recipe 事件在气泡下方挂 `RecipeCard`（含「存入菜谱库」）；error 红字入气泡；done 解锁输入
- 组包：`buildHistory` 纯函数——旧消息映射 + 末尾追加当前 user 消息 + 过滤空文本气泡（首轮曾漏带当前消息导致核心链路 400，修复后有专项测试）
- **聊天记录不持久化**：仅内存 state，刷新即丢（设计文档 5.2 确认）；localStorage/IndexedDB 全库禁止

### 一键入库

卡片按钮 → `toDraft` 白名单重组（剥 id/createdAt/updatedAt——服务端 DraftRecipe schema strict，多字段即 400；保 `source:'ai'`）→ POST /api/recipes → 201 置「已入库」。`savedIds + savingIds` 双防抖：已入库与请求 in-flight 均禁用按钮，双击不会双入库。

## 为什么这么做

| 决策 | 理由 |
| --- | --- |
| SSE 而非 WebSocket | 单向推送足够（用户消息是普通 POST）；SSE 过 HTTP/1.1 无需协议升级，部署简单 |
| recipe 以事件推送、入库不二次调 AI | 点「入库」时若重新生成：成本翻倍且可能生成**另一个**菜谱（用户入库的不是刚看到的）——推送已见数据保证所见即所得 |
| 菜谱解析在服务端而非前端 | 解析逻辑（状态机/重试/覆写）只写一份；前端只管渲染事件 |
| 手动泵 reader 而非 TransformStream | 异步重试（aiComplete）在泵循环内更可控；abort 双路径（signal + cancel 回调）传播比 TransformStream 显式（审查裁定：除背压外不劣于 TransformStream，SSE 文本量级背压可忽略） |
| 只发首个菜谱，标签后正文丢弃 | 协议选择「一问一菜谱」；模型在 `</recipe>` 后的客套话无产品价值 |
| 移动端自动滚底 | 流式输出时用户视线跟随最新内容 |

## 优缺点

**优点**

- 打字机式流体验，长菜谱无需干等完整响应
- 入库链路零二次成本：看到的即入库的
- 协议健壮：半截标签扣留、截断流、abort、纯对话（无菜谱）都有专项测试
- 不持久化带来零隐私残留与零会话管理成本

**缺点与已知边界**

- 刷新即丢对话（已确认的产品取舍；有价值的菜谱靠入库留存）
- 每轮对话全量历史随请求发送，超长对话 token 成本线性涨（自用节奏可忽略；上限可在前端截断）
- 多轮中 RETRY_HINT 可能追加到 assistant 消息（仅非标准客户端可触发，标准 UI 历史恒以 user 结尾）
- 单次回答只支持一个菜谱（协议取舍）

## 架构位置

```
ChatView ──apiFetch POST /api/ai/chat──► chat route ──aiChatStream──► 上游模型
   ▲            │ readSse 解析                │ 泵+状态机+重试
   └── 气泡/卡片 ◄── message/recipe/error/done ◄─┘
   └─ 入库 ──► POST /api/recipes ──► recipe-store
```
