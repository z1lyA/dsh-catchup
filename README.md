# 接上 · dsh-catchup

> 你切回一个会话，第一句话总是「我刚才干到哪了？」
> 这个插件就是那一句话的答案。

DeepSeek Harness 的右侧栏插件。点一下对话头部的「接上」，右栏打开，一眼看到：

- **这是什么会话**（一句话：你当初要什么、它当时怎么回）
- **需要你拍板**（待批准的命令 / 它问你的问题及选项 / 没做完的活 / 没事等你）
- **现在停在哪**（最后一轮它自己怎么说的）+ 之前几轮怎么走到这里
- 一行机器事实：多少轮、上次动什么时候、上下文烧了多少、模型、目录

看完关掉，进去接着干。

![面板结构](docs/preview.svg)

## 零模型调用

全部数据来自 DSH 已经在本地折好的**会话投影**，插件一次模型调用都不发，也不烧 token；对当前会话更是**零额外请求**：

| 显示的东西 | 来源 |
|---|---|
| 现状句、最近几轮 | `turnOutline` 投影（每轮 prompt ≤50 字 + response ≤120 字） |
| 待你拍板的问题原文与选项 | `userQuestions` 投影 |
| 待批准 / 运行中 / 未读 | `useSessionStatus()` 实时推送 |
| 没做完的活 | `todos` 投影 |
| 轮次、上下文、模型 | `sessionStats` / `tokenUsage` / `modelSelection` |
| 标题、目录、上次互动 | `session/list` 摘要块 |

面板**只读当前会话**——你切到哪个会话，它讲哪个。不列别的会话，因此也不需要为冷会话取数。

## 安装

```powershell
plugin_manager install_bundle  <这个目录的绝对路径>
```

装完刷新页面：对话头部多一个「↩ 接上」按钮，点它右栏打开；空右栏也会直接显示它的入口。

## 路由

| 位置 | 槽位 | 说明 |
|---|---|---|
| 标签页类型 | `ctx.sidebarRightTabs.register` | id `dsh-catchup`，kind `catchup`，`keepMounted` |
| 面板正文 | `sidebar.right.pane.tab`（key = id） | 全部 UI 在这里 |
| 标签文字 | `sidebar.right.pane.tab.title` | 「接上」 |
| 头部按钮 | `conversation.session.header.utilities` | order −8，**只有图标**（和设计台那个按钮一样），悬停显示说明 |

## 界面

设计源文件在 [`design/catchup.html`](design/catchup.html)：套的是 DSH 官方右侧栏外框，浅色和深色都量过（对比度、字号、点击区、溢出全部通过）。

插件里不写内联样式，而是注入一段前缀化的 `.dsh-catchup` 样式表。灰阶用 `color-mix(in oklab, currentColor …)` 从正文色混出来，所以**不依赖 `data-theme` 属性也能跟着深浅色走**——这个坑躲掉了：DSH 自带的 `--dsh-muted` 在白底只有 3.7:1，直接用会不够对比度。

## 开发

```powershell
npm test          # = node test/logic.test.mjs && node test/render.test.mjs
```

两个测试都不需要浏览器：

- `test/logic.test.mjs` — 从 `lib/client.js` 的 `// #region logic` 切出纯函数单独跑，再查中英词典覆盖、导出文件存在、槽位注册齐全、有没有偷偷混进模型调用或 RPC、`cordis.patch.yml` 是不是合法 YAML。
- `test/render.test.mjs` — 用假 `window.__ModuleLoader__` 真加载 `lib/client.js`，假 React 真渲染组件，检查「待批准 / 等你回答 / 没事等你 / 空会话 / 管线折叠 / 状态行」这几种情况下吐出来的字对不对。

`plugin_manager install_bundle <目录>` 装的是**软链接**（`link:H:/...`），改完源码刷新页面就生效，不用重装。

## 已知限制

- **现状句是截断的**：`turnOutline` 的 response 上限 120 个 UTF-16 单位、空白已折叠，所以读起来是"半句话"，不是完整总结。
- **`todos` 在空闲时是上一轮残留**（新一轮开始时清空），所以它只当兜底信号。
- **待批准只能显示它自己带出来的文字**：`pendingInteraction` 没有公开的 payload 契约，插件是防御式取值的（`title`/`description`/`summary`/`label`/`reason`），取不到就只显示"有东西等你批准"。
- **右栏布局按会话各存一套**：切到没开过这个 tab 的会话，右栏是关着的——这是 DSH 自己的行为，与本插件无关。
- **`approvalState` 浏览器读不到**（host-only，没有 wire），所以"等你批准"只能从 `pendingInteraction` 拿。

## 另一个没做的产品

「跨会话总览看板」——解决"从一堆会话里挑一个切过去"。做过可行性验证但没实现，代价分析和可复用函数都记在 [`docs/ALTERNATIVES.md`](docs/ALTERNATIVES.md)。

## 许可

MIT
