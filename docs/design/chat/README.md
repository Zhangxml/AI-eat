# 模块：AI 对话（聊天页 + /api/ai/chat）

> 代码位置：`src/app/api/ai/chat/route.ts`（SSE 服务端）、`src/lib/sse.ts`（事件编码）、
> `src/lib/sse-client.ts`（前端解析）、`src/components/ChatView.tsx`（聊天 UI）、`src/lib/chat-history.ts`（组包）、
> `src/lib/ai-prompts.ts` 的 `CHAT_MENU_FORMAT_RULE` / `extractChatMenuJson`（清单协议与解析）
> 消费方：首页 `/`（问问AI）

## 做什么

应用的主入口：一个对话式界面，用户用自然语言说需求，AI 按两种路径响应：

1. **食材推荐清单**（默认路径）：用户列出食材（「冰箱有番茄和鸡蛋」）→ AI 按食材数量输出推荐清单（每道菜标主角食材+理由）→ 用户确认想做哪道 → 点「生成菜谱」→ 展开完整菜谱卡片 → 一键入库
2. **完整菜谱直出**：用户明确要某道菜的做法（「红烧鱼怎么做」）→ AI 直接输出完整菜谱卡片，可一键入库

与买什么模块的分工：**问问AI 有食材输入**（推荐以现有食材为主角的菜），**买什么无食材输入**（按人数配一桌菜+采购清单）。

## 怎么做的

### SSE 事件协议（前后端契约，一字不差）

```
event: message   data: {"t":"<正文增量>"}          ← 结构化标签出现前的流式文本
event: recipe    data: <完整 Recipe JSON>          ← <recipe> 闭合（id/时间戳已覆写）
event: menu      data: {dishes:[{name,ingredient,reason}]}  ← <menu> 闭合（食材推荐清单）
event: error     data: {"error":"<中文>"}          ← 解析两次失败/上游异常
event: done      data: {}                          ← 收尾（error 之后照常发，不中断流）
```

### 双标签状态机（RecipeStreamSplitter）

`RecipeStreamSplitter` 同时识别 `<recipe>` 与 `<menu>`：

- text 态增量外发，尾部半截标签字面量扣留（`<rec`/`<men` 跨增量不泄漏，取两种开标签扣留长度的最大值）
- 进入先出现的标签态（indexOf 取最小位置），标签内内容缓冲不外发
- 闭合回调：`<recipe>` → onRecipeComplete、`<menu>` → onMenuComplete；首个任一标签闭合后 structSeen=true，后续正文与标签全部丢弃（协议只发首个结构化输出）
- 流中途截断在标签态：flush 快照未闭合缓冲**及标签类型**，走同一条提取路径（裸 JSON 平衡扫描可解出未闭合但完整的 JSON）

### 提示词分流（CHAT_MENU_FORMAT_RULE）

系统提示词三规则并存，让模型按用户意图自选输出形态：

```
- 列食材想做菜 → <menu> 清单：dishes 数量与食材数量一致，一种食材对应一道菜（主角食材标注），
  清单阶段禁止输出 <recipe>（等用户确认）
- 烹饪知识/闲聊 → 正常文字，不输出标签
- 明确要某道菜做法 → <recipe> 完整菜谱
```

`extractChatMenuJson` 校验 `{dishes:[{name,ingredient,reason}]}`（三字段非空字符串，复用平衡扫描兜底）；与买什么的 menuSchema 无关（那边无 ingredient、有 category/shopping）。

### 前端（ChatView）

- `readSse` 消费四类事件；menu 事件挂到当前 assistant 消息下方渲染清单卡片（每菜一行：菜名+主角食材徽标+理由）
- **逐菜生成**：每道菜的「生成菜谱」按钮 → `POST /api/ai/recipes { dish }` → 该菜下方展开 RecipeCard → 入库。`dishStates` 以「消息下标:菜名」为键（跨清单同名菜互不干扰），per-dish 独立 loading 互不阻塞，失败局部红字可重试
- 入库：toDraft 剥离+savedIds/savingIds 双防抖（与原单菜谱路径完全同款）
- 组包 `buildHistory`：旧消息+末尾 user 消息+过滤空文本气泡；聊天记录不持久化

## 为什么这么做

| 决策 | 理由 |
| --- | --- |
| 清单先行而非直接生成完整菜谱 | 用户需求：给出 N 个食材时往往只得到 1 个菜（且未必想做）——按食材数量出清单，把「做哪道」的决定权还给用户，成本只花在确认后的那道菜上 |
| 复用 /api/ai/recipes 生成完整菜谱 | 该接口已具备结构化输出/重试/覆写全套能力，第二段零新增服务端代码 |
| menu 与 recipe 两条协议并存而非替换 | 「红烧鱼怎么做」直出菜谱仍是高频路径；提示词按意图分流，状态机兼容两态 |
| 双标签取最先出现者进入 | 模型偶发同时输出两种标签时行为确定（取位置靠前），不会卡死或双发 |
| ingredient 字段独立于菜名 | 展示「主角：番茄」徽标，用户能看出哪种食材对应哪道菜——这是按食材推荐的核心信息 |
| SSE 而非 WebSocket | 单向推送足够；无协议升级，部署简单 |

## 优缺点

**优点**

- 食材利用率可视化：3 个食材出 3 道菜，每道标注主角，不遗漏不堆叠
- 确认制把生成成本与用户意图对齐（只生成想做的菜）
- 双标签状态机一条流同时覆盖「推荐」与「直出」两种产品路径
- 逐菜独立生成：多道菜并行请求互不阻塞，失败不扩散

**缺点与已知边界**

- 「清单 vs 直出」的分流靠提示词遵循度（模型可能在该出清单时直出菜谱——此时行为退化为旧版，不致错）
- menu 事件数据无 id，跨清单同名菜以「消息下标:菜名」区分键
- 聊天记录不持久化，清单确认后刷新需重新描述食材（已确认的产品取舍）
- 清单条数无硬上限（提示词约束「与食材数量一致」靠模型遵循；食材很多时建议用户分批说）

## 架构位置

```
ChatView ──apiFetch POST /api/ai/chat──► chat route ──aiChatStream──► 上游模型
   ▲            │ readSse                     │ 双标签状态机（recipe|menu）
   │            ├── message → 气泡增量          ├─ <recipe> ─► extractRecipeJson ─覆写─► recipe 事件
   │            ├── menu → 清单卡片             └─ <menu> ───► extractChatMenuJson ─────► menu 事件
   │            └── error/done
   └─ 确认某菜 ─► POST /api/ai/recipes ─► RecipeCard ─入库─► POST /api/recipes ─► recipe-store
```
