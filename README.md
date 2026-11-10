# dsh-qa-isolation

> DeepSeek Harness (DSH) 插件包 + Agent 预设：**问答窗口**。
> 一个会话里连续问互不相关的问题，每个新问题都只带着"当前这一问"进入模型。

A DSH bundle that adds a `Q&A` agent preset: each new question is answered from a clean context, so unrelated questions in one window never contaminate each other.

## 两种模式，随时切换（隔离不是强制的）

**单问模式是默认值，不是唯一行为。** 想连续追问，点一下 composer 上的开关或输入 `/qa follow` 即可，此后就恢复正常的不中断对话；想再隔离回来用 `/qa fresh`。

| 模式 | 模型看到什么 | 适用 |
|---|---|---|
| **单问**（默认） | 只有系统提示 + 当前这一问 | 一个窗口里问一堆互不相关的问题 |
| **追问** | 系统提示 + 切换后累积的问答 | 同一个话题需要多轮深入 |

切换只影响**之后**的问题，历史仍完整保留在会话日志与界面转录里，随时可回看。

English: isolation is the **default, not a forced behavior** — flip the composer toggle or run `/qa follow` for normal multi-turn conversation, `/qa fresh` to go back.

## 为什么需要它

DSH 的会话是追加式事件溯源日志，不变量是"模型可见 ⟺ 已写日志"：没有任何配置开关能让一个会话"只看最新一条消息"。内置的压缩（compaction）会把旧历史换成摘要，但旧问题会以摘要形式残留下来，且每次都要额外调用一次模型写摘要。

这个插件走官方支持的 **surface 替换**路径（与压缩落检查点同一条持久机制）：在每个新问题的第一步，把系统提示之后的全部旧节点替换成一条短标记。

- 模型只看到「系统提示 + 标记 + 当前问题」；
- **零额外模型调用**，无摘要残留；
- 会话日志本身仍完整、可恢复，重启与恢复后行为一致。

## 上下文会不会爆

单问模式下**跨轮次不累积**：每次替换都把上一问和上一答一起移出，模型输入规模基本是个常数。两个例外由预设里挂的压缩组兜底——同一轮内的大量工具结果，以及单条超长输入（一次粘几十万 token 的日志）。

切到追问模式后上下文会正常累积，长对话交给压缩处理。

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
- **按钮出现时机**：composer 席位常驻、组件只挂载一次，切换会话后开关可能在下次页面聚焦时才刷新——手动切走再切回即可。

## 更新与发版

本地迭代：目录即插件本体（符号链接安装），改完 `node --check index.js && node --check client.js`，然后**重启 DSH**——替换已安装包的 JS 必须加载新模块代，热重载覆盖不到。

发布新版本：

1. 改 `package.json` 的 `version`（与 tag 保持一致）；
2. `git commit` + `git push origin main`；
3. `git tag -a vX.Y.Z -m "..."` + `git push origin vX.Y.Z`；
4. `gh release create vX.Y.Z --title ... --notes ...`。

> 升级提示：pnpm 会用 lockfile 钉住 `github:owner/repo` 已解析出的 commit，所以已装过的用户重新安装未必自动升级。发版说明里请给出显式 ref：
> `github:ShadowTang98/dsh-qa-isolation#vX.Y.Z`
> 新增运行时文件时记得同步进 `package.json` 的 `files`，否则别人装到的是缺文件的版本，而本地因符号链接一切正常。

## 开发

克隆本仓库后，以本地目录形式安装（符号链接，改文件即改插件；改 JS 需重启 DSH 加载新模块代）：

> 安装 bundle `D:\path\to\dsh-qa-isolation`

或在 profile 的 `dependencies` 里写 `"dsh-qa-isolation": "link:D:/path/to/dsh-qa-isolation"` 后 `pnpm install`。

MIT 许可证见 [LICENSE](LICENSE)。
