# RelayPact：5 分钟 Codex-to-Codex 开始指南

[English](agent-quickstart.md) | [简体中文](agent-quickstart.zh-CN.md)

本指南会让一个 clean Git 仓库从安装走到第一个有边界、可审查的
Codex-to-Codex candidate。RelayPact 使用现有 Codex CLI 中的独立
`codex exec`，不需要第二个 executor package。

RelayPact 的通用目标是指导 Host 委派与验收。本教程演示已发布的 Codex capsule
工具流程。当前源码的 [Host 规约](../skills/relaypact/SKILL.md) 已区分通用责任与 CLI
配置；该修订尚未包含在下文安装的 v0.1.2 中。本教程的候选要到后续获得授权的应用
步骤才会写入源码。

当前发布事实：

- 当前源码为 **0.2.0 Public Preview source candidate**，尚未发布；
  下文的 release 安装不包含这些候选改动。
- `v0.1.2` 是最新已发布版本；`v0.1.1` 仍可使用。
- 本指南安装版本化 tag，并验证 peel 后的 commit SHA。
- Pi 是 experimental、inactive；本流程不会安装、加载或调用它。

精确 CLI 与 JSON 字段见[手工配置参考](manual-configuration.md)。

## 第 0 分钟：检查前置条件

需要 Node.js 20 或更高版本、Git、Codex CLI 0.147.0 或更高版本：

```bash
node --version
git --version
codex --version
codex exec --help
```

仅安装 Codex Desktop 不能证明 CLI 或 `codex exec` 可用。独立 worker 会产生
独立模型请求，可能额外消耗额度或费用。

## 第 1 分钟：安装并验证 v0.1.2 release

把下面的提示词交给协调 Codex：

```text
请把 https://github.com/echopath-labs/relaypact 的版本化 v0.1.2 release tag
克隆到目标仓库之外的本地工具目录。记录精确 checkout commit SHA，并将它与
peel 后的 v0.1.2 tag commit 做精确比较。确认 package.json 和 plugin.json
都报告 0.1.2；读取 README.md 和最近的 AGENTS.md；验证 Node.js 20+、Git、
Codex CLI 0.147.0+ 和 `codex exec --help`。通过 local marketplace 安装根
Plugin。在不读取凭据、不连接 provider、不启动 worker 的情况下，运行安装后
Skill-local 的 `support` 和 `doctor`。报告精确 commit、版本、Plugin 与 Skill
discovery、Codex-to-Codex readiness 和剩余配置。不要 accept、apply、commit、
push、tag、publish、release 或 deploy。
```

等价的 release 命令是：

```bash
git clone --branch v0.1.2 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.1.2
checkout_commit="$(git -C relaypact-v0.1.2 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.1.2 rev-parse 'v0.1.2^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.1.2
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.1.2"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

官方 tag 只是版本选择器，不是独立的密码学保证。如需 dogfood 当前源码，应使用
单独的 development-only checkout、记录精确 commit，且绝不能把它描述为 release
安装：

```bash
git clone --branch main --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-current-source
git -C relaypact-current-source rev-parse HEAD
```

## 第 2 分钟：新建 Codex 任务

新建 Codex 任务，让 `$relaypact` 出现在 Skill catalog。让 Agent 再次运行安装后
Skill-local 的 `support` 和 `doctor`；这些命令不会加载 Pi、读取凭据、连接
provider 或启动 worker。

预期 readiness 报告包括：

- Codex CLI 与 `codex exec` 版本/能力；
- Plugin、marketplace `relaypact-local` 与 Skill discovery；
- 静态 `codex-codex: public-preview` 支持状态；
- 本机 `ready`、`needs_setup` 或 `blocked` 状态及修复建议。

## 第 3 分钟：执行一个真实的首次委派

选择一个适合新增单个文档文件的 clean Git 仓库。替换下面的
`<目标仓库绝对路径>` 后发送：

```text
请使用 $relaypact 执行下面这个有边界的 Codex-to-Codex 委派。

目标仓库：<目标仓库绝对路径>
目标：创建 docs/relaypact-first-delegation.md，写一份简洁 onboarding checklist：
如何找到最近的 Agent 指令、如何运行项目已记录的验证，以及何时必须停止并请求
人类授权。

执行前只读取 README.md，以及存在时最近的 AGENTS.md。只允许写入
docs/relaypact-first-delegation.md。禁止修改 .git、凭据、环境文件、现有源码和
其他所有路径。只使用 Codex-to-Codex public-preview 路线与 host 批准的 Codex
profile；不得 fallback 到 Pi、其他 harness、provider 或模型。

使用等价的 host validation：
- ["git", "diff", "--check"]
- ["test", "-s", "docs/relaypact-first-delegation.md"]

Envelope、profile、state 和 archive 数据只能放在目标仓库之外的私有目录。启动
worker 前展示 host/executor 身份、精确可读与可写路径、验证、路线、私有位置和
尚未解决的权限问题。Worker 返回后，检查实际 patch、范围与验证证据、凭据安全和
剩余风险。

报告 executor 是否返回 completed，以及 candidate 是否具备 acceptance 资格后
停止。不要 accept、apply、commit、push、tag、publish、release 或 deploy。
```

如果目标仓库 dirty，除非每个既有路径都被明确确认，否则 Agent 应拒绝继续。只读
路径属于 `readablePaths`，不属于 `allowedPaths`，也不能匹配
`forbiddenPaths`。

## 第 4 分钟：审查 candidate

Executor 的 `completed` 只是自我报告，不是验收。协调 host 必须独立解释：

- 实际 changed paths 与 candidate patch；
- source/capsule baseline 与范围证据；
- host 执行的验证结果；
- credential-evidence 安全；
- 尚未解决的风险与 acceptance eligibility。

Review metrics 会把 `relaypactPromptBytes`、
`relaypactResultSchemaBytes`、`relaypactDeclaredInputBytes`、复制的上下文
字节与 provider token 分开记录。RelayPact 字节数不是 token、额度、费用、隐藏
harness 或额外开销估算。

需要改变 scope、context 或 route authority 时，应创建新任务。Same-session
correction 只用于原身份和权限范围内的缺陷。

## 第 5 分钟：先决定，再单独 apply

`completed` != `accept` != `apply`：

- `completed`：executor 结果；仍待审查。
- `accept`：独立审查证据后由 host/人类明确决定；candidate patch 仍未应用。
- `apply`：重新核对 accepted archive identity 与当前 source base 后，在另一次
  授权下修改源码。

另外两个终态选择是 `reject` 和 `abandon`。如果 candidate 已 accept，使用
单独提示词：

```text
本次委派已经 accept。请重新读取归档 candidate patch，确认它的 evidence identity
与已验收记录一致，解释准备应用的每个文件，并确认 source base 没有漂移。等待我
单独授权。现在不要 apply、commit 或 push。
```

Commit、push、tag、GitHub Release、包发布和部署都还需要进一步的独立授权。

## 首次运行排障

| 症状 | 处理 |
| --- | --- |
| `codex` 或 `codex exec` 不可用 | 安装或升级受支持 CLI；不存在单独 executor package。 |
| `doctor` 返回 `needs_setup` | 把 source checkout 重新添加为 `relaypact-local`，安装 Plugin，新建任务并重跑 doctor。 |
| Plugin 已安装但没有 `$relaypact` | 新建 Codex 任务，并检查 `codex plugin list --marketplace relaypact-local --json`。 |
| 目标仓库 dirty | 使用 clean 仓库，或明确确认每个既有路径及额外审查负担。 |
| Native Codex 认证不可用 | 修复选中的 host-owned Codex profile；不要把凭据粘贴进任务文件。 |
| Context 或 scope 不足 | 停止并申请一个新的有界任务；不得静默扩大 correction。 |
| Validation 或范围证据失败 | 不得 accept；保存证据并在原边界内修正，或创建新任务。 |
| Provider 或 stream 失败 | Fail closed；未获新批准前不得改变 harness、provider、模型或路线。 |

安装/版本验证、已发布 `v0.1.0` 安装、升级、卸载、私有 archive 保存以及完整排障
见[手工配置参考](manual-configuration.md)。Provider-specific 配置不属于首次
路径；只有明确选择时才阅读 [OpenCode Go / Luna](opencode-go-luna.md)。

RelayPact 使用 [Apache License 2.0](../LICENSE)（`Apache-2.0`）。
