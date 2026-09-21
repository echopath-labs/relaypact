# RelayPact

[English](README.md) | [简体中文](README.zh-CN.md)

RelayPact 给 Host Agent（甲方）一套稳定的委派与验收参考。Host 约定任务、明确权限、
核对真实证据、处理偏差，并在用户授权内做出验收决定；executor（乙方）接入提供兼容的
调用方式与证据工具。

[Host Skill](skills/relaypact/SKILL.md) 说明这些通用要求，具体工具参考按需读取。
[八个审查案例](examples/host-delegation-cases.md) 给出可观察的行为预期。
0.3.3 包含这份规约及实验性 Cursor、WorkBuddy 路线。通用 Host 措辞不代表新增
其他 Host 产品支持；支持矩阵中接纳的 Host 仍为 Codex。

根 Plugin 的默认路线是 **Codex → Codex**。RelayPact 提供流程、
隔离、证据和验收约束；真正执行任务的是用户现有 Codex CLI 中的独立
`codex exec` 进程。不需要安装第二套 Codex 或单独的 executor package。

对这条 Codex-to-Codex 路线：**不需要额外安装 executor。**

> 英文 `README.md` 是规范性默认版本；如中英文冲突，以英文为准。

## WorkBuddy 乙方接入

0.3.0 新增实验性 **Codex → WorkBuddy 大陆版**、**Codex → WorkBuddy AI 国际版**
乙方路线。
每次显式选择版本，并为本次委派指定一个精确模型 ID；账号与登录仍复用各自桌面原生配置。
RelayPact 会在发送任务前检查该 ID，并作为唯一 `--model` 参数传入，不配置 fallback，
也不修改桌面默认设置；该检查不证明账号权益、价格或免费状态。
首版限定 macOS、内置 CLI 2.137.1，以及 Read/Write 文件任务；由 Host 独立检查和验收。
修正通过新的有界任务完成，暂不接纳 shell 执行和同会话续跑。详见
[WorkBuddy 调用参考](skills/relaypact/references/workbuddy.md)。

## 发布状态

v0.3.3 的发布目标是面向 Host 监督下实际委派工作的普通 GitHub Release。委派机制与约束
将继续通过审核与实践优化。产品发布状态与各适配路线的成熟度分别标注。

- 源码包元数据：**0.3.3**。
- 安装目标版本：**v0.3.3**。
- 支持状态：`codex-codex` 是 `public-preview`；`codex-pi` 保持
  `experimental`、inactive；`codex-cursor` 已包含源码，但仍是
  `experimental`，且不在根 Plugin 中激活。WorkBuddy 两版同样为显式选择的实验性乙方。

以 [`support-matrix.json`](support-matrix.json) 为准。Cursor 路线必须显式选择，
并要求本地存在兼容且已登录的 Cursor CLI。Cursor 自己管理认证与模型选择；只有
Cursor 主动报告模型元数据时，RelayPact 才进行观察和展示。Pi、Cursor、OpenCode
CLI、OpenCodex、第三方 provider 或特定模型都不是 Codex-to-Codex 的前置条件或
fallback。

Cursor 的一次性命令仍只返回 pending；可选的私有 state-root 模式增加签名持久审查、
受保护的同 session correction，以及显式归档的终态决策。它不会修改 Cursor 模型设置，
终态决策步骤也不会应用或撤销变更；直接执行期间可能已经修改了工作区。持久 correction 会保留原始只读或写入权限，并在恢复 session 前
校验绑定的 Cursor 绝对启动路径，以及存在时已解析的 shebang 解释器身份。`prepared` 任务或具有签名执行结束证据的失败任务，可由 Host 显式 abandon
并清理私有状态；活跃执行 owner 仍存活时会拒绝清理。中断的 `running` 任务
或缺少结束证据的旧失败状态返回 `execution_stop_unverified` 并保留私有状态。
Host 退出不能证明分离进程已停止；当前不支持这类遗留执行的自动恢复。

这是由人类审查的预览版，不适合无人值守或生产关键任务。已验证前置条件包括
Node.js 20 或更高版本、Git、Codex CLI 0.147.0 或更高版本，并且
`codex --version` 与 `codex exec --help` 都可用。macOS 已完成本地验证；只有当
某个版本的精确候选通过公开 CI 后才声明该版本通过 Ubuntu 验证。暂不声明支持
Windows。

## 用 v0.3.3 release 在五分钟内开始

使用版本化 `v0.3.3` tag 完成可复现的 release 安装。安装前确认
[GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.3) 已可见；
包版本元数据或 PR 本身不代表已发布。

安装前必须确认 [v0.3.3 GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.3) 已可见。
若尚不可用，停止这组安装步骤，改用 [v0.3.2](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.2)。
本文的版本化说明不代表远端发布已经完成。

把下面的提示词交给一个协调 Codex：

```text
请把 https://github.com/echopath-labs/relaypact 的版本化 v0.3.3 release tag
克隆到目标仓库之外的本地工具目录。记录精确 checkout commit，将它与 peel 后的
v0.3.3 tag commit 做精确比较，并确认 package.json 和 plugin.json 都报告 0.3.3。
读取 README.md 与最近的 AGENTS.md。验证 Node.js 20 或更高版本、Git、
Codex CLI 0.147.0 或更高版本和 `codex exec --help`。通过 local marketplace
安装根 Agent Plugin，不启动 worker，然后运行安装后 Skill-local 的 `support`
和 `doctor`。报告精确 checkout commit、版本、Plugin 与 Skill discovery、
Codex-to-Codex readiness 和剩余配置。不要读取凭据，也不要配置、调用、accept、
apply、commit、push、tag、publish、release 或 deploy 任何内容。
```

等价的 release 命令是：

```bash
set -e
git clone --branch v0.3.3 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.3.3
checkout_commit="$(git -C relaypact-v0.3.3 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.3.3 rev-parse 'v0.3.3^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.3.3
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.3.3"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

安装后新建 Codex 任务，再继续阅读[5 分钟开始使用](docs/agent-quickstart.zh-CN.md)。
其中包含一个调用 `$relaypact` 的真实、有边界、只创建一个可审查文档文件的
首次委派。

## 安装目标版本

执行本节命令前，确认官方 [v0.3.3 GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.3) 已可见；若不可见，请停止并使用 [v0.3.2](https://github.com/echopath-labs/relaypact/tree/v0.3.2)。仅有 tag 不满足安装前提。

安装目标版本是 `v0.3.3`：

此前的 `v0.1.2`、`v0.1.1` 与 `v0.1.0` release 仍可用于精确的历史版本安装。

```bash
set -e
git clone --branch v0.3.3 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.3.3
checkout_commit="$(git -C relaypact-v0.3.3 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.3.3 rev-parse 'v0.3.3^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.3.3
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.3.3"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

官方仓库 tag 只是版本选择器，**不是独立的密码学保证**。只有通过另一个可信渠道
获得完整 commit SHA 时才做独立精确比对。

如需 dogfood 可变的当前源码，应把 development-only 路径与 release 安装明确
分开，并记录精确 commit。`main` checkout 只包含已合并内容，不一定包含候选分支
或未提交工作区描述的全部修订：

```bash
git clone --branch main --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-current-source
git -C relaypact-current-source rev-parse HEAD
```

## 一分钟理解生命周期

对 Codex capsule 路线，候选与源码保持分离：

`completed` != `accept` != `apply`：

1. `completed` 是 executor 结果和候选证据，仍需独立 host 审查。
2. `accept` 是 host 或人类审查实际 patch、范围、验证、凭据安全和剩余风险后做出
   的明确终态决定；patch 此时仍未应用。
3. `apply` 是之后单独授权的源码修改，执行前还要重新核对 accepted archive 和
   当前 source base。

Commit、push、tag、GitHub Release、包发布和部署还是更进一步的独立动作。
验收不会赋予这些权限；已有且适用的用户授权可以沿用，无需重复询问。

Cursor 与 Pi 直接在工作区执行，审查前可能已经发生修改。接受不会应用另一份 capsule
patch，拒绝也不会自动撤销工作区变更。一次性结果在工具层仍为 pending；只有支持的
持久模式才能记录工具终态决策。

## 安全与可观测性

- 凭据只保留在 host 管理的配置或环境授权中，不能进入 task envelope、示例或
  公开文档。
- Executor 只能获得声明的上下文和写权限。只读路径可读、不可写，也不能被禁止。
- 路线或上下文失败时 fail closed，绝不会静默 fallback 到 Pi、Cursor、其他
  harness、provider 或模型。
- Host review 会把 `relaypactPromptBytes`、`relaypactResultSchemaBytes`、
  `relaypactDeclaredInputBytes`、选中上下文字节与 provider token 分开记录；这些
  字段不是 token、额度、费用或隐藏 harness 开销估算。
- 独立 executor 会产生独立模型请求，可能额外消耗额度或费用。
- 本项目不是操作系统级安全沙箱。处理不受信任代码或凭据前请阅读
  [SECURITY.md](SECURITY.md)。

## 安装生命周期与文档

- [5 分钟开始使用](docs/agent-quickstart.zh-CN.md)
- [5-minute getting started](docs/agent-quickstart.md)
- [安装、版本验证、升级、卸载、排障与 CLI 参考](docs/manual-configuration.md)
- [Codex-to-Codex adapter 参考](packages/adapter-codex-codex/README.md)
- [实验性 Codex-to-Cursor adapter 参考](packages/adapter-codex-cursor/README.md)
- [示例](examples/README.md)
- [发布清单](RELEASING.md)
- [贡献指南](CONTRIBUTING.md)
- [NOTICE](NOTICE) 与 [Apache License 2.0](LICENSE)（`Apache-2.0`）

## v0.3.3 变更

- 为可识别的 Cursor 文件系统权限错误提供安全、可操作的诊断。
- 覆盖 Node 错误包装、更多文件操作及含单引号的路径。
- 不回传原始诊断，保留失败、范围、超时和取消检查。

详情与兼容性说明见 [CHANGELOG](CHANGELOG.md)。

## 开发验证

```bash
npm ci --ignore-scripts
npm run check:codex-codex
npm run check:codex-cursor
npm run check
```

默认测试是离线确定性测试。Cursor readiness 可以在不发起模型请求的情况下检查；
真实 Codex、Cursor 执行、Pi、router 和 provider smoke 必须显式启用，并可能
消耗本地资源或账户额度。

## 大型仓库的证据预算

适配器会检查忽略文件、未跟踪文件及 Git 变化。默认文件系统证据预算为
512 MiB，安装依赖后的 monorepo 即使 Git 干净也可能超限。v0.3.2 支持 Host
通过 `execution.filesystemEvidenceMaxBytes` 显式配置最高 8 GiB 的预算，
并在任务全程保持一致。配置、扫描成本和独立限制见
[预算说明](skills/relaypact/references/task-envelope.md#filesystem-evidence-budget)。
v0.3.1 安装版仍使用固定的 512 MiB 限制。
