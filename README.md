# dsh-qa-isolation

> DeepSeek Harness (DSH) 插件包 + Agent 预设：**问答窗口**。
> 一个会话里连续问互不相关的问题，每个新问题都只带着"当前这一问"进入模型。

A DSH bundle that adds a `Q&A` agent preset. In a session using that preset, every new question is answered from a clean context — earlier exchanges are removed from the model's input (and from the cost) — with a one-click toggle for follow-up questions.

## 为什么需要它

DSH 的会话是追加式事件溯源日志，不变量是"模型可见 ⟺ 已写日志"：没有任何配置开关能让一个会话"只看最新一条消息"。内置的压缩（compaction）会把旧历史换成摘要，但旧问题会以摘要残 form 泄漏，且每次都要额外调用一次模型写摘要。

这个插件走官方支持的 **surface 替换**路径（与压缩落检查点同一条持久机制）：在每个新问题的第一步，把系统提示之后的全部旧节点替换成一条短标记。

- 模型只看到「系统提示 + 标记 + 当前问题」；
- **零额外模型调用**，无摘要残留；
- 会话日志本身仍完整、可恢复，重启与恢复后行为一致。

## 安装

需要 DSH `0.2.2-rc.1` 或更高（依赖 `dsh-agent-preset`、`dsh-persona`、`dsh-tool-web`）。

**方式一 · 让 DSH 自己装（推荐）**：在任意 DSH 会话里说

> 安装 bundle `github:ShadowTang98/dsh-qa-isolation`

Agent 会用 `plugin_manager` 的 `install_bundle` 完成安装与启用。

**方式二 · 插件市场**：装了 [dshmarket](https://github.com/Ebony-Vinyl/dshmarket) 的话，在 DSH 插件页的 Discover 里从 GitHub 源添加本仓库。

**方式三 · 手工**：在 profile 目录（`%USERPROFILE%\.dsh\profiles\<profile>\package.json`）里加依赖与 bundle：

```jsonc
{
  "dsh": { "profile": { "bundles": ["dsh-qa-isolation"] } },
  "dependencies": { "dsh-qa-isolation": "github:ShadowTang98/dsh-qa-isolation" }
}
```

然后在该目录执行 `pnpm install` 并重启 DSH。

安装后**重启 DSH**（新增的是 Host 组合里的插件行，热重载覆盖不到），然后在"新建会话"的 Agent 预设里选择 **Q&A**。

## 使用

| 操作 | 效果 |
|---|---|
| 默认 | 单问模式：每个新问题清空上下文，只回答当前这一问 |
| `/qa follow` 或点按钮 | 追问模式：保留当前仍在上下文里的问答 |
| `/qa fresh` 或点按钮 | 切回单问模式 |
| `/qa` | 查询当前模式 |

composer 工具行（模型选择器旁）会出现「单问 / 追问」开关，**只在 Q&A 预设的会话里出现**，其他预设自动隐藏。

模式记录在会话日志里（`/qa` 的命令事件），所以刷新页面、重开程序都会恢复到你上次选的模式；每个会话的模式各自独立。

> 注意：切到追问模式**不会恢复**此前已被移除的问答——它只保留幸存部分。这是设计使然，切换提示里也会明确写出。

## 组成

一个双半包 + 一条 Host 行 + 一个预设声明：

- `index.js`（Host 半）：surface 替换、`/qa` 命令、开关的 `/dsh-qa/mode` 路由。放在 profile 而非预设内——预设行要等会话选中才激活，那时浏览器半已错过客户端模块图组装。
- `client.js`（浏览器半）：composer 里的开关，纯 React + 主题变量，不覆写任何官方组件。
- `cordis.patch.yml`：注册上述行，并声明 `preset-qa`（问答 persona + 联网工具 + 压缩组）。

插件只对运行 `config.preset`（默认 `qa`）指定预设的会话生效，判断取自预设注册表，取不到时回退到会话日志的 `agent-preset/selected` 与创建 header。

## 代价与边界

- **前缀缓存失效**：每次替换会使 provider 的前缀缓存从第一条历史 token 起失效，因此每个问题按全量输入计价。问答场景本来就是独立问题，通常可接受。
- **界面转录不折叠**：Chat 渲染的是已加载的事件窗口而非 surface，所以旧问答在界面上仍可回看，只有模型上下文被清空。折叠转录需要接管官方 Chat 节点渲染（`shadows-shipped-ui` 级），风险高于收益，故未实现。
- **追问模式不恢复历史**：切到追问只保留"当前仍在上下文里"的问答；此前已被移除的内容不会回来。
- **按钮出现时机**：composer 席位常驻、组件只挂载一次，切换会话后开关可能在下次页面聚焦时才刷新——手动切走再切回即可。

## 开发

克隆本仓库后，以本地目录形式安装（符号链接，改文件即改插件；改 JS 需重启 DSH 加载新模块代）：

> 安装 bundle `D:\path\to\dsh-qa-isolation`

或在 profile 的 `dependencies` 里写 `"dsh-qa-isolation": "link:D:/path/to/dsh-qa-isolation"` 后 `pnpm install`。

MIT 许可证见 [LICENSE](LICENSE)。
