# 接上 · 细节说明

## 它解决的那个动作

不是"从一堆会话里挑一个切过去"，而是：

> **我刚切回这个会话，它停在哪？有没有事在等我？**

所以这个面板：

- 只讲**当前会话**
- 打开就为了读，读完就关，不常驻、不记忆开关、不做跳转
- 右栏是每个会话一套布局的，所以切到别的会话它自然就不在（DSH 官方行为）

## 面板结构

1. **需要你拍板**（最上面，因为这是唯一的决策）
   优先级：`pendingInteraction`（批准/提问） > `userQuestions.active`（它问你的，带选项） > 未完成的 `todos` > 无事
2. **现在停在哪** — 最后一轮 `response` 的首句，剥掉 markdown 后压到 110 字
3. **最近几轮** — 每轮「你（prompt）/ 它（response）」各一句，默认最近 4 轮，可展开全部
4. **状态行** — 轮次 · 上次动 · 上下文 token · LLM 累计耗时 · 模型 · 目录

## 一个模型调用都没有

| 字段 | 来源 | 当前会话要额外请求吗 |
|---|---|---|
| `turnOutline` | `session/control` 基线（全量值，含被摘要块排除的键） | 不要 |
| `todos` | 同上 | 不要 |
| `sessionStats` | 同上 | 不要 |
| `tokenUsage` | 同上 | 不要 |
| `userQuestions`（问题原文 + 选项） | `session/list` 摘要块 | 不要 |
| `title` / `displayTitle` / `cwd` | `session/list` | 不要 |
| `sessionListMetadata.lastPromptAt` | `session/list` 摘要块 | 不要 |
| `modelSelection` | 投影 | 不要 |
| 运行中 / 待批准 / 未读 | `useSessionStatus()` 实时推送 | 不要 |

面板只读**当前**会话，而当前会话永远是 attached 的，所以这一切都是**零请求、零 token、瞬时**。跨会话看板才需要为冷会话发 `session/projections`，那个代价记在 `docs/ALTERNATIVES.md`。

## 事实依据（DSH 0.2.2-rc.5 上验证）

- `turnOutline` 每轮只有 `{turn, seq, prompt ≤50, response ≤120}`，**UTF-16 单位**截断、空白已折叠；`draft`（进行中那一轮）**不上线**，所以面板看不到未完成的一轮。
- `todos` 在 `turn/start` 时被清空，空闲态看到的是**上一轮残留**，经常全是 completed —— 只当兜底。
- `approvalState` **浏览器读不到**（host-only，无 `wire`），"等你批准"只能来自 `pendingInteraction`。
- 右栏 tab 类型契约：`{id, kind, multiple?, keepMounted?, patterns?, priority?, canOpen?, title, guide?}`；正文注册进 **keyed** 的 `sidebar.right.pane.tab`，key = 类型 id。
- 正文容器是 `height:100%; overflow:hidden`，**滚动必须自己管**（本插件在根 div 上 `overflowY:auto`）。
- 宽度不可由插件指定：默认 45%，最小 300px，最大 70%，刷新后重置。
- 一个 pane 里同一 page kind 只能有一页；不同类型可共存（会和设计台并排成两个 chip）。

## 代码地图

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半边，空的。挂载它是为了让 client 被加载 |
| `lib/client.js` | 全部 UI 与逻辑。`// #region logic` 是纯函数区，被测试直接引用 |
| `test/logic.test.mjs` | 无浏览器的验证：逻辑 + 词典覆盖 + 接线 + 禁止项 |
| `locale/*.json` | 插件管理页的标题与说明 |

## 为什么要 `try/catch` 包住每个注册

四个注册任何一个抛错（例如上游改了槽位名），都只该让**那一个座位**消失，而不是把整个客户端模块的 `apply` 打断。所以每个 `ctx.effect(...)` 都单独包了 `try/catch` 并 `console.warn`，出问题在控制台能直接看到是哪一个。

## 已知缺口

- 现状句是截断的首句，会丢细节；这是取舍。
- `pendingInteraction` 的 payload 形状没有官方契约，只能防御式取值。
- 没做"复制这份简报"和"标为已读"——前者容易做成半个导出功能，后者会和官方的未读语义打架。
