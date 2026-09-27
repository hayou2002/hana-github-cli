# GitHub CLI App for Hana

把官方 [GitHub CLI](https://cli.github.com)（`gh`）桥接为 [HanaAgent](https://github.com/liliMozi/openhanako) 工具的 v2 App。

装好之后，你的 AI 助手就能自己查登录状态、跑 `gh` 命令、引导你完成 GitHub 授权——不用再手动来回切换终端。本仓库的第一次真实任务，就是用这个 App 把它自己上传到了 GitHub。

## 特性一览

- 🖥 **管理面板卡片**：安装 / 登录 / 退出三段式交互。点「登录」→ 左侧出现可复制的一次性代码并自动弹出授权页；授权成功后面板自动变已登录；已登录时按钮变「退出登录」
- 🛠 **五个工具入驻模型**：状态诊断 / 一键安装 / 通用命令执行 / 双方式登录 / 退出登录，覆盖 gh 完整生命周期
- 🔌 **GitHub 直连纪律**：起子进程前自动清除残留的代理环境变量（`HTTP_PROXY` 等），不让陈旧配置阻断 GitHub 访问；直连瞬时失败时明确提示重跑而非误导去配代理
- 🧭 **登录全程引导**：设备码流程返回结构化三步操作指引，失败原因分类（网络瞬时干扰 / 需人工介入），后台轮询进程保证存活到授权完成
- 🔐 **令牌零经手**：token 登录经 stdin 直交 `gh auth login --with-token`，App 不落盘、不回显、不留副本；凭据由 gh 自己管理
- 🌐 **设备码流程**：启动 `gh auth login --web`，解析一次性代码返回给用户，浏览器点一下完成授权
- 🧱 **安全执行边界**：参数以数组直传 `execFile`，不经过 shell，无通配/管道/变量展开；含 shell 元字符的参数直接拒绝
- ⏱ **资源兜底**：默认 60s、上限 180s 超时；输出 60K 字符截断并提示用 `--jq`/`--limit` 收窄
- 🧯 **诊断友好**：gh 未安装时给出安装命令；命令失败时附带常见原因提示（未登录/无权限/不在仓库内）

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| HanaAgent | ≥ 0.1050.9 | 提供 v2 App 运行时 |
| GitHub CLI | ≥ 2.x | `winget install --id GitHub.cli` / `brew install gh` |

App 启动时按 `GH_CLI_PATH` 环境变量 → 平台默认安装路径 → `PATH` 中的 `gh` 依次解析可执行文件。

## 安装

**方式一：安装包（推荐）**

从 [Releases](../../releases) 下载 `app-github-cli-x.y.z.zip`，在 Hana 的扩展管理里选择本地安装，审阅权限后启用。

**方式二：源码目录**

把 `github-cli/` 整个目录复制到 `<HANA_HOME>/apps/`，Hana 会在扩展面板的「应用」分类里列出待批准条目，确认后加载。

声明的权限共四条：

| 权限 | 用途 |
|---|---|
| `app/tools.expose-to-model` | 把五个工具注册给 AI 模型调用 |
| `app/process.spawn` | 以子进程方式执行 `gh` 命令 |
| `app/ui.clipboard-write` | 面板里一键复制一次性登录代码 |
| `app/ui.open-external` | 面板里打开 GitHub 授权页 |

## 管理面板

应用在卡片中心提供一张「GitHub CLI 管理面板」卡片：

| 区块 | 未就绪 | 就绪后 |
|---|---|---|
| 安装 | 「未安装」+ **一键安装** 按钮，安装日志实时回显 | 「已安装 · 版本号」 |
| 账号 | 「未登录」+ **登录** 按钮 | `账号 @ 主机 · 协议 · scope`，按钮变**退出登录** |

点「登录」后：左侧出现**可复制的一次性代码**，浏览器自动打开授权页；面板每 2.5 秒轮询，浏览器点完 Authorize，面板自动切到已登录。

## 工具说明

### `github_cli_status`

无参数。返回 `gh --version` 与登录账号/scope/协议摘要，用于环境体检和故障诊断；未安装 gh 时提示一键安装。

### `github_cli_install`

无参数。在本机安装 GitHub CLI：Windows 走 `winget install --id GitHub.cli`，macOS 走 `brew install gh`。装完自动重新探测。

### `github_cli_run`

通用 `gh` 命令桥。核心参数：

- `args`（必填）：`gh` 之后的参数数组，如 `["repo","list","--limit","20"]`
- `cwd`（可选）：运行目录，git 上下文相关命令需要
- `timeoutMs`（可选）：超时毫秒数

读操作可直接执行；写操作（create / merge / delete 等）按约定先向用户展示完整参数并获确认。

### `github_cli_login`

两种方式，取决于你手边有什么：

- `mode: "device"`——无需任何令牌，返回一次性代码和 [授权页](https://github.com/login/device)，浏览器完成即可
- `mode: "token"`——提供 GitHub Personal Access Token，经 stdin 交给 gh 保存

### `github_cli_logout`

退出本地登录（`gh auth logout`，只删本地凭据，不吊销远端令牌）。

## 使用示例

装好后直接对助手说：

> 「看看我的 GitHub 登录状态」
> 「列出我最近的 20 个仓库」
> 「给 owner/repo 提一个 issue，标题是……」
> 「用 gh 登录我的 GitHub」

助手会自行选择合适的工具完成。

## 项目结构

```
├── github-cli/            # App 源码（可直接放入 <HANA_HOME>/apps/）
│   ├── manifest.json      # v2 清单
│   ├── index.js           # 三个工具的注册与实现
│   ├── assets/icon.svg    # 应用图标（Octocat 风格重绘）
│   └── sdk/               # 本地打包的 Hana App SDK（运行时免依赖）
├── dist-extensions/       # 打包产物：安装 ZIP + 市场 entry.json
├── CHANGELOG.md
└── README.md
```

## 开发

修改 `github-cli/index.js` 后，用 [hana-app-creator](../../) 技能链校验打包：

```bash
node scripts/validate_app.mjs --dir github-cli --smoke   # 静态校验 + 冒烟启动
node scripts/pack_app.mjs --dir github-cli --publisher "你的名字" --out ./dist-extensions
node scripts/validate_app.mjs --archive dist-extensions/app-github-cli-x.y.z.zip --smoke
```

## 已知限制

- `gh` 的交互式 TUI（如 `gh pr create` 向导）不适合本桥接，请使用带完整 flag 的非交互写法
- 输出超过 60K 字符会截断，大数据量请配合 `--jq` 过滤或 `--limit` 控制
- 设备码授权等待窗口约 15 分钟，超时需重新发起
- 本 App 为社区作品，与 GitHub 官方无隶属关系；图标为 Octocat 风格自绘

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE)。`github-cli/sdk/` 目录为 HanaAgent 官方 SDK 打包产物，遵循其上游许可。
