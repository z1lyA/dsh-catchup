# 会话摘要 · 细节说明

## 它解决的那个具体动作

不是"从一堆会话里挑一个切过去"，而是：

> **我要回到这个会话继续干活了。它现在停在哪？有没有事在等我？**

所以这个面板：

- 只讲**当前会话**，不讲别的会话（要跨会话的话进 `ALTERNATIVES.md` 那套）
- 打开就为了读，读完就关，不常驻、不记忆开关、不做跳转
- 右栏是每个会话一套布局的，所以切到别的会话它自然就不在（官方行为）

## 面板结构

1. **待你拍板**（在最上面，因为这是唯一的决策）
   优先级：待批准 > agent 在问你（带选项） > 未完成 todo > 无事（显示"没事等你拍板"）
2. **现状** — 最后一轮它自己的说法，取首句
3. **最近几轮** — 每轮"你问 / 它答"各一句，默认最近 4 轮，可展开全部
4. **状态行** — 轮次、上次互动、上下文 token、LLM 累计耗时、模型、目录

## 一个模型调用都没有

全部读 DSH 已经在本地折好的投影：

| 字段 | 来源 |
|---|---|
| `turnOutline` | 当前会话的 `session/control` 基线（全量值，含摘要块排除的键） |
| `userQuestions` | `session/list` 摘要块（含问题原文与选项） |
| `todos` | 同上投影流 |
| `sessionStats` / `tokenUsage` / `sessionListMetadata` / `modelSelection` / `goal` | 同上 |
| 运行中 / 待批准 / 未读 | `useSessionStatus()` 实时推送 |
| `title` / `displayTitle` / `cwd` | 会话列表 |

因为面板只读**当前**会话，而当前会话永远是 attached 的，所以这一切都是**零请求、零 token、瞬时**——不需要为冷会话发 `session/projections`（那是跨会话看板才要付的代价）。

## 事实依据（DSH 0.2.2-rc.5 上验证）

- `turnOutline` 每轮只有 `{turn, seq, prompt ≤50, response ≤120}`，UTF-16 单位截断，空白已折叠，且 **`draft` 不上线**（进行中的那一轮看不到）。
- `todos` 在 `turn/start` 时被清空，所以空闲态看到的是**上一轮残留**，经常全是 completed —— 只当兜底信号用。
- `approvalState` **浏览器读不到**（host-only，没有 wire），"正在等你批准"只能来自 `pendingInteraction`。
- 右栏 tab 类型契约：`{id, kind, multiple?, keepMounted?, patterns?, priority?, canOpen?, title, guide?}`；正文注册进 `keyed` 的 `sidebar.right.pane.tab`，key = 类型 id。
- 正文容器是 `height:100%; overflow:hidden`，**滚动要自己管**。
- 宽度不可由插件指定：默认 45%，最小 300px，最大 70%，刷新后重置。

## 已知缺口

- `pendingInteraction` 的 payload 形状没有官方契约，面板是**防御式**取值（`title/description/summary/label/reason`），取不到就只显示"有东西等你批准"。
- 现状句是 120 字截断的首句，会丢细节；这是取舍。
