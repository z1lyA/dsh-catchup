# 会话摘要 · dsh-session-digest

DeepSeek Harness 的右侧栏插件：**进一个会话之前，先读它的一份简报。**

打开右栏的「会话摘要」标签，一眼看到：

- 这个会话**现在停在哪**（最后一轮它说了什么，压成一两句）
- **有没有事等你拍板**（待批准的命令 / agent 问你的问题及选项 / 没做完的 todo / 上一轮报错）
- 最近几轮发生了什么
- 轮次、上次互动、token 占用

看完关掉，进去接着干。

## 零模型调用

全部数据来自 DSH 已经在本地算好的**会话投影**，插件一次模型调用都不发，也不烧 token：

| 显示的东西 | 来源 |
|---|---|
| 现状句、最近几轮 | `turnOutline` 投影（每轮 prompt ≤50 字 + response ≤120 字） |
| 待你拍板的问题原文与选项 | `userQuestions` 投影 |
| 待批准 / 运行中 / 未读 | `useSessionStatus()` 实时推送 |
| 未完成的 todo | `todos` 投影 |
| 轮次、token、模型 | `sessionStats` / `tokenUsage` / `modelSelection` |
| 会话标题、目录、上次互动 | `session/list` 摘要块 |

## 安装

```powershell
# 在 DSH 里
plugin_manager install_bundle  H:\CodeProject\dsh-session-digest
```

装完刷新页面，对话头部多一个「会话摘要」按钮，点它右栏打开。

## 已知限制

- **现状句是截断的**：`turnOutline` 的 response 上限 120 个 UTF-16 单位，且空白已折叠。它是一句"半句话"，不是完整总结。
- **`todos` 在空闲时是上一轮残留**（新一轮开始时清空），所以它只当兜底信号。
- **待批准只能显示"有东西等你批准"**，命令内容取决于 `pendingInteraction` 能带出多少。
- **右栏布局按会话各存一套**：切到没开过这个 tab 的会话，右栏是关着的（这是官方行为，与本插件无关）。

## 备选方案

「跨会话总览看板」——解决"从一堆会话里挑一个切过去"的另一个产品。做过可行性验证但没实现，设计、代价和可复用代码都在 [`docs/ALTERNATIVES.md`](docs/ALTERNATIVES.md)。
