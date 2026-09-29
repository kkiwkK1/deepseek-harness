---
description: "pi Agent 预设组合包：以 read、write、edit 和一个平台 shell 组成的精简四工具操作空间，可安装的组合层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-pi

[English](README.md) | 中文

## 概述

`dsh-pi` 加入 **pi** Agent 预设：模型的全部操作空间只有四个工具 —— `read`（分页文本与图片）、`write`、`edit`，以及一个平台 shell（Windows 之外用 `bash`，Windows 上用 `pwsh`）。搜索、列目录、构建和测试都通过 shell 完成；问题以普通回复送达用户。随发行版附带的 Web 与 Desktop profile 默认选中本组合包，任何已初始化的 profile 也可以显式安装。它不改变默认行为：会话仍从 `standard` 预设开始，直到用户选择 pi。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 在会话中选择 pi

启动 `dsh --profile web`（或 Desktop），新建任务后在 Agent 预设选择器中选择 **Pi 模式**；也可以在通用设置里把它设为新任务默认。每个会话保留自己的预设，pi 会话与标准会话可以在同一进程内并行。

### 安装到其他 profile

本组合包已包含在 Web 与 Desktop profile 模板中。其他已初始化的 profile 显式添加：

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-pi
```

该 profile 必须已包含 `@deepseek-ai/dsh-base`，以及挂载 Agent 预设的表层（Web 组合或其上的 `dsh-headless`）。用 `dsh plugin --profile <name> remove @deepseek-ai/dsh-pi` 移除后，预设从清单中消失。

### 模型看到什么

| 工具 | 职责 |
|---|---|
| `read` | 分页读取 UTF-8 文本与图片（图片直接经 `read` 返回；不注册独立的 `read_image`） |
| `write` | 创建或完整替换文件 |
| `edit` | 精确字面替换，带唯一性与版本校验 |
| `bash` / `pwsh` | 搜索、列目录、构建、测试与运行命令 —— 一个平台 shell，仅前台 |

仓库指令、工作目录、平台上下文、审批流程、沙箱和会话记录都沿用现有服务。后台任务、技能、目标、计划模式、子代理、工作流、网页工具与插件管理一概不注册。

<a id="understand-the-implementation"></a>
## 理解实现

本包的运行时内容是一份 patch 文档：[`pi.patch.yml`](pi.patch.yml) 插入 `preset-pi` 行 —— 一个建立在 base + web-app 层之上的 `@deepseek-ai/dsh-agent-preset` 声明。该预设挂载 `dsh-persona`（标准身份加一句「问题用普通回复」）、`dsh-agent-instructions`、仅前台运行的 shell 行（`enableRunInBackground: false`、`promoteOnTimeout: false`）、`imageReadMode: integrated` 的 `dsh-tool-fs`、`mode: native` 的 `dsh-agent-tool-presentation`，以及压缩组（`compaction-basic`、`command-compact`、`tool-result-pruner`）—— 后者是不注册模型可见工具的会话基础设施。

其余全部继承：agent loop、文件系统与 shell 提供方、沙箱与审批、附件和会话记录都不需要 pi 专属代码。统一的图片读取位于 `dsh-tool-fs`，其 README 记录了 `imageReadMode` 的契约。

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-tool-fs`](../../fs/tool-fs/README.zh.md) —— 四工具文件系统套件与集成式图片读取
- [`dsh-agent-preset-registry`](../../preset/agent-preset-registry/README.zh.md) —— 预设清单、按会话绑定与组合盘点
- [`dsh-web-app`](../web-app/README.zh.md) —— 为 Web 与 Desktop 挂载 Agent 预设的表层

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

人设保留标准身份、工作目录，以及一句「问题用普通回复」；随发行版的 `agent-instructions` 行仍注入仓库指令，运行时上下文（平台与环境）照常渲染。pi 未挂载工具的指引根本不会注册，因此提示词只包含 read 与 shell 各自的段落。

##### Read 指引

```markdown
Use the read tool — not shell commands like cat — to inspect text files and images. Use offset and limit to continue reading large text files; image reads return the image itself and accept neither argument.
```

#### Token 影响

四工具目录让首个请求比 `standard` 少掉所有未挂载工具的 schema 与指引；人设新增的只有那一个句子。

#### KV 缓存影响

在预设挂载的工具与指引不变时前缀稳定；切换预设会从第一个变化的 token 起失效。

### 工具 schema

#### 模型看到什么

恰好是生成的 [`read`、`write`、`edit` 与一个 shell schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-fs) —— Windows 之外用 `bash`，Windows 上用 `pwsh` —— 旁边没有 `read_image`：pi 行为 `dsh-tool-fs` 配置了 `imageReadMode: integrated`，`read` 自己声明 PNG/JPEG/WebP/GIF。shell schema 不携带 `run_in_background` 参数（`enableRunInBackground: false`）。

#### Token 影响

该工具视图下每个请求的固定 schema 成本。

#### KV 缓存影响

可见工具定义与顺序不变时前缀稳定。

### 工具结果

#### 模型看到什么

文本读取返回带续读页脚的行号窗口；图片读取在信封旁返回图片本身；shell 返回退出码与截断到尾部的输出及完整输出文件路径。超时或取消直接终止命令 —— 不会返回后台任务 id。

#### Token 影响

读取上限与 shell 输出截断约束每个结果；保留的调用与结果在压缩前逐请求重发，压缩行为沿用 `standard`。

#### KV 缓存影响

只追加；新可见内容跟随可复用的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **技能未发布进 pi** —— 现有技能目录依赖 `tool-skill` 加载，而 pi 不挂载它。后续版本可增加显式技能扩展。
- **无扩展名的图片文件仍走文本路径** —— 集成式路由仅依据扩展名，无扩展名的图片会被文件系统提供方按二进制拒绝，而不是作为图片读取。
- **在本组合包之前初始化的 Desktop profile 保留旧的层列表** —— 可在插件页或用 `dsh plugin add` 添加。

<a id="dev-note"></a>
### 开发备注

[`tests/pi.spec.ts`](tests/pi.spec.ts) 固定声明的组合：四个挂载的工具行、仅前台的 shell 开关、集成式图片路由、显式原生调用，以及其余所有模型可见工具行的缺席。[`pi-preset` Web 快照](../../../snapshots/web/pi-preset/) 无密钥重放一段会话，断言四工具请求、两种 read 形态与浏览器卡片。

**运行时不变量：** 未发布伴随包。本组合包挂载其他包的预设与服务；所有生命周期与执行关系都属于被组合的包。
