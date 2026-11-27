# 接上 · 细节说明

## 它解决的那个动作

不是"从一堆会话里挑一个切过去"，而是：

> **我刚切回这个会话，它停在哪？有没有事在等我？**

所以这个面板：

- 只讲**当前会话**
- 打开就为了读，读完就关，不常驻、不记忆开关、不做跳转
- 右栏是每个会话一套布局的，所以切到别的会话它自然就不在（DSH 官方行为）

## 面板结构

三块，**没有小标题**——层级由字号、颜色、位置承担，不靠标签：

1. **这是什么会话**（顶部，13.5px、淡一档，是背景不是重点）
   优先用会话自己声明的 `goal`；没有就取**第一轮**：你的开场要求 + 它当时回的结论，用 ` —— ` 连成一句。只有一轮的会话不写这段（会和下面的"现状"重复）。
2. **需要你拍板**（唯一带颜色的块，琥珀色左边框 + 极淡底）
   优先级：`pendingInteraction`（批准/提问） > `userQuestions.active`（它问你的，带 A/B/C 选项） > 未完成的 `todos` > 无事（一行灰色的"没事等你，接着干就行"）
3. **现在停在哪**（15px，正文最大的一档）
   最后一轮它自己的说法，剥掉 markdown 后压到 160 字；紧跟着是**之前**的几轮（默认 6 轮，可展开），最后一行是机器事实（轮次 · 上次动 · 上下文 token · LLM 耗时 · 模型 · 目录）。

为什么"最近几轮"不含最后一轮：**最后一轮已经在上面那段里了**，再列一遍是同一句话出现两次。

三块用 `justify-content: space-between` 铺满面板高度，剩余空白**平均分到块与块之间**，而不是堆在底部；内容变多时自动收回 20px 的下限。

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

- 现状句是截断的首句，会丢细节；这是取舍。原料来自 `turnOutline`，每轮只留你的提问 50 字 + 它的回答 120 字（UTF-16 单位、空白已折叠），**上限是 DSH 折叠时写死的，不是插件选的**。要全文就得再写一个 Host 半边，用 `session/assistantOutput(...)` 定向取最后一条助手消息——0 token，但多一次请求。
- `pendingInteraction` 的 payload 形状没有官方契约，只能防御式取值。
- 没做"复制这份简报"和"标为已读"——前者容易做成半个导出功能，后者会和官方的未读语义打架。

## 样式怎么落进插件

设计稿是 `design/catchup.html`（DSH 官方右侧栏外框，浅色/深色都过 `check_design`）。

插件里**不用内联 style**：`apply()` 时往 `<head>` 塞一段 `<style id="dsh-catchup-style">`，所有规则挂在 `.dsh-catchup` 下。两条纪律由测试守住：

1. 标记里用到的每个 `cu-*` 类，样式里必须有对应规则；样式里也不许有没人用的规则。
2. 每条规则必须以 `.dsh-catchup` 开头，否则会漏进宿主 UI。

灰阶不用 DSH 的 `--dsh-muted`（白底只有 3.7:1），而是 `color-mix(in oklab, currentColor 62%, transparent)`：从正文色混出来，深浅色自动跟着走，也就不必知道 DSH 有没有设 `data-theme`。

