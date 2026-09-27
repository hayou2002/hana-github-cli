# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

> **版本规范**：自 0.2.0 起，每个小改动递增第三位（0.2.0 → 0.2.1 → 0.2.2 …），只有成组的新功能才动第二位。

## [0.2.8] - 2026-09-28

### 重构（代码健康度）

本版无功能变化，只做冗餘清理与健壮性修正。

**删掉的冗餘**
- `gh-core.js`：`PROXY_ENV_KEYS` 改为模块私有（仅 `cleanEnv` 内部使用，无外部引用）；`ghExecutableCandidates` 移除从未被使用的 `pathApi` 参数及其派生变量
- `panel.js`：删除定义后从未使用的 `DEVICE_URL` 常量；`/open-device` 改用 `ROUTE` 常量（之前是硬编码字符串，与 `ROUTE` 体系不一致）
- `manifest.json`：移除多余的 `app/ui.open-external` 能力声明——浏览器打开走后端 `cmd /c start`，代码从不调用 `hana.external.open`。少一个能力声明就少一项用户授权

**消除重复**
- `index.js`：任务状态的 8 字段字面量在三处重复（初始/启动/重置），抽为 `makeJob(patch)` 工厂，保障字段形状一致
- `panel.js`：健康状态点原本在 `renderAuth()` 里“顺手”设置，未安装 gh 时会被 auth 逻辑写成“未登录”红点，语义混淆。抽出独立的 `renderHealth()`，由整体就绪度（未安装 → 未登录 → 等待授权 → 就绪）统一决定

**修正的问题**
- **依赖重复声明的真实缺陷**：`ghPath` 在回调作用域内被 `let` 了两次（先加入“并发记忆化”时引入），运行时会抛 `Identifier 'ghPath' has already been declared`。已删除旧声明
- `readEnvironment()` 串行跑两次 gh 子进程（`--version` + `auth status`），改为 `Promise.all` 并行；`/status` 轮询频繁调用它，每次省一次进程启动
- `resolveGh()` 加上 in-flight 记忆化：并行调用共享同一次解析，不再各自重查
- 修正 `buildElevateCommand` 的过时注释（原文写“非 Windows 返回 null”，但函数从不返回 null）

### 验证
- 单测 17/17 通过；ESM 模块解析通过（含反向对照，确认该检查能抓出重复声明）
- Edge 无头截图回归：多主题 × 多状态渲染与 0.2.7 一致

## [0.2.7] - 2026-09-28

### 新增
- **面板跟随宿主主题**：之前面板写的是旧主题变量名（`--accent` 等），而宿主在自定义主题模式下只注入 `--hana-*` 前缀名，导致面板在任何主题下都停在硬编码的橙黄色，与整体界面割裂。现在：
  - `<head>` 读 iframe URL 参数（`hana-css` / `hana-theme-appearance` / `hana-palette-*-css`），动态挂载当前主题样式表
  - CSS 采用 **`--hana-*`（custom） → 旧主题名（hana/legacy） → 暖色默认值** 的取值链
  - 圆角跟随宿主的 `--hana-corner-radius-scale` 偏好
- **卡片封面重画**：深色圆角方块（与面板头部的品牌锚点同构）+ 白色 Octocat + 绿色状态点；340/190/92/54px 四档实拍均清晰
- **品牌锚点**：面板头部加 GitHub mark 方块，卡片一眼可识别

### 变更（UI/交互优化）
- **按钮分清主次**：一张卡只留一个实心主操作（升级 / 登录），危险操作（卸载 / 退出登录）改为描边红；实心红只留给“确认”那一下
- **信息层级**：标题与版本/状态点分层排版；两段卡片各配图标（终端 / 账号）
- **语义化色彩**：所有浅底/描边改用 `color-mix` 从主题色推导，不再用固定 `rgba`——深色主题下同样成立（原先 `word-break: break-all` 会把 `read:org` 拆成 `read:o rg`，已改 `overflow-wrap: anywhere`）
- 版本标签底色改为从文字色推导，不依赖主题是否定义 `sidebar-bg`

> 验证：Edge 无头截图实测 5 个内置主题（absolutely / midnight / coral / high-contrast / grass-aroma）+ 2 个模拟 custom 主题 × 4 种状态（已装已登录 / 未安装 / 安装中 / 等待授权）。

## [0.2.6] - 2026-09-28

### 修复
- **一键安装报「Access to this API has been restricted. Use --allow-fs-write to manage permissions.」**：Hana 用 Node 权限模型启动 App 进程，只放行一个可写根（`--allow-fs-write=<ctx.dataDir>`）；而旧代码把安装包下载到系统临时目录 `os.tmpdir()`，正好在写名单之外，于是被宿主拒绝。已改为写入 `sdk.dataDir/downloads/`（宿主唯一授权的可写目录）。卸载不落盘，所以之前卸载能用而安装不能用——差异正好坐实了这一根因
- 下载目录残留安装包：`dataDir` 不随卸载清空，每次安装前先清掉旧 MSI；另修一个隐患：**沙箱内 `fs.rmSync` 会静默失效**（不报错但不删），改用 `fs.unlinkSync`
- **含空格路径下的安装/卸载提权失败**：`buildElevateCommand` 原来把参数以逗号数组交给 `Start-Process -ArgumentList`，PS 5.1 会用空格拼接，含空格的参数（如用户名带空格的 `C:\Users\Zhang San\...`）会被拆散。改为把整串按 Windows 引号规则拼接后作为单个字符串传入；卸载传的是 GUID（无空格）所以一直正常

> 复现证据（均已在本机实测）：
> - 本机以 `node --permission --allow-fs-write=<dataDir>` 模拟宿主沙箱：写 `os.tmpdir()` → `ERR_ACCESS_DENIED`（与截图一字不差）；写 `dataDir` → `WRITE_OK`
> - 同沙箱下 `fs.rmSync` 报成功但文件仍在；`fs.unlinkSync` 正常删除
> - 用真实 `buildElevateCommand` 生成命令、真实 PowerShell 执行、子进程回传 argv：GUID / 含空格路径 / 含单引号+空格路径 三组均逐字一致

## [0.2.5] - 2026-09-28

### 修复
- **空的小横条不消失 / 复制按钮登录后不隐藏 / 确认框不消失**（同一根因）：样式表缺 `[hidden]` 规则，而 `.progress / .code-row / .confirm` 都设了 `display:flex`，把 HTML 的 `hidden` 属性盖掉了。加 `[hidden] { display: none !important; }` 一行根治
- **点「退出登录」无反应**：面板在 iframe 沙箱里，`window.confirm()` 被禁而静默失败。改为**面板内独立确认卡**（取消 / 确认）
- **浏览器不自动打开**（0.2.4 引入的回归）：上一版把开浏览器从后端（`cmd /c start`，可用）挪到了面板的 `hana.external.open`（iframe 内失败）。改回后端打开，面板只负责展示
- **升级到相同版本号时一直转圈**：新增版本比对短路——已是最新时直接反馈「已是最新版本」并停止，不做多余下载
- **重装/卸载卡住**：安装与卸载改为**提权执行**（`Start-Process -Verb RunAs` 触发 UAC）；进程非管理员时 MSI 静默装/卸必然失败，这是根因

### 新增
- 拆出 `lib/gh-core.js` 纯逻辑层（环境清洗、版本解析/比对、登录态解析、设备码提取、镜像排序、提权命令构造），配有 `tests/gh-core.test.mjs`（16 条断言，`node tests/gh-core.test.mjs` 可跑）
- 安装任务支持多源依次重试：最快源 → 其余源 → winget

### 变更
- **卡片封面重画**：去掉强行添加的五官（官方剪影加眼睛必歪），改为深色圆盘 + 白色 Octocat 居中剪影 + 右下绿色状态点；实测 360/200/96/56px 四档均清晰可辨
- 安装段 UI：任务进行中才显示进度条；完成后显示 **升级 / 重装 / 卸载** 三按钮；日志面板每次打开自动清除上次残留，另配手动 × 清除

## [0.2.4] - 2026-09-28

### 修复
- **退出登录点不了 / 链接点不了 / 确认弹窗无反应**（同一病根）：面板在 iframe 沙箱里，`window.confirm()` 被禁而静默失败。改为**面板内确认条**（取消 / 确认两个按钮），不再依赖任何原生弹窗；授权页链接改为绑定 `hana.external.open`
- **安装日志洗不掉**：面板每次打开时先调 `/clear-log` 清除上次任务残留（任务进行中时后端忽略该请求），并新增日志 × 按钮手动清除

### 新增
- **安装引擎重写**：先测速挑选最快下载源（直连 / gh-proxy / ghproxy.net / ghfast），再下载官方 MSI 静默安装；msiexec 失败自动回退 winget；下载失败自动换第二快的源
- **实时进度**：下载阶段显示百分比进度条 + 当前步骤小字（如“下载安装包（gh-proxy.com）· 43%”），不再只是转圈
- **三按钮布局**：已安装时显示 **升级 / 重装 / 卸载**（替代原单一“重新安装”）；`github_cli_install` 工具同步支持 `mode=install|upgrade|uninstall`

### 变更
- **卡片封面简化**：由堆满信息的一屏降为一个 Q 版 GitHub 猫（深色圆底 + 白猫剪影 + 圆眼高光），小尺寸下也能一眼认出

## [0.2.3] - 2026-09-28

### 修复
- **卡片封面比例**：原封面为 960×600 横版，在卡片位显示不下。改为 512×512 正方形（对齐官方脚手架默认封面的 1:1 比例）
- **登录浏览器行为**：确认 `hana.external.open` 走宿主 `shell.openExternal`（即系统默认浏览器、复用已有窗口），不会开隔离/无痕窗口；面板改为统一经 `openDevicePage()` 调用，去掉服务端的 `cmd /c start` 分支，避免两条不同的打开路径

## [0.2.2] - 2026-09-27

### 修复
- **面板「一键安装」失效**：路由先把 `installState.running` 置真、再调用安装函数，而后者开头就判断 `running` 为真直接返回，等于永远不装。重构为幂等的 `startInstall()`（共享同一 Promise）
- **设备码流程并发串扰**：多个登录流程时，旧流程的 `close` 回调会误标记新流程。改为每次流程持有独立对象，回调只关自己
- token 登录未复用已解析的 gh 路径，现统一走 `resolveGh()`

### 变更
- 后端根据职责分区重写：常量 / 环境与路径 / 进程执行 / 状态读取 / 设备码 / 安装 / 工具 / 路由；抽出统一的 `run()`/`gh()` 执行器与 `text()`/`fail()` 结果封装，消除重复
- 前端面板改为单一 state + 单一 `render()` 的渲染模型，去掉“传假 state 再渲染”的取巧写法；复制/按钮/提示拆为独立小函数
- 安装与设备码状态均改为可幂等启动，安装支持完成后重装

## [0.2.1] - 2026-09-27

### 修复
- **面板复制一次性代码失效**：`hana.clipboard.writeText` 在部分 iframe 环境下不生效，改为三级兜底——宿主剪贴板（短超时）→ `navigator.clipboard` → `execCommand('copy')`；三级都失败时自动弹出可全选输入框，提示手动 Ctrl+C
- 安装流程图未标明面板入口：现在明确画出“卡片中心 → 应用”标签（真实入口位置）

## [0.2.0] - 2026-09-27

### 新增
- **管理面板卡片**（`contributes.cards` + `sdk.routes`）：面板内置三段式交互，不再只靠对话
  - **安装段**：显示 gh 安装状态与版本；未安装时提供「一键安装」，安装过程实时回显日志，装完自动重新探测
  - **登录段**：已登录显示账号 / 主机 / 协议 / scope，并提供「退出登录」（走 `gh auth logout`，只删本地凭据）；未登录时按钮变成「登录」，点击后**左侧显示可复制的一次性代码，同时自动打开浏览器授权页**，面板每 2.5 秒轮询，授权成功自动切换为已登录状态
  - **刷新**：手动重读状态；活动中的安装/授权会自动轮询
- **`github_cli_install` 工具**：Windows 走 `winget install --id GitHub.cli`，macOS 走 `brew install gh`；供助手在用户没有 gh 时主动补装
- **`github_cli_logout` 工具**：退出本地登录（`gh auth logout`），执行前应向用户确认
- 新增两项界面能力声明：`app/ui.clipboard-write`（复制一次性代码）、`app/ui.open-external`（打开授权页）

### 变更
- `github_cli_status` 改用 `gh auth status --json hosts` 读取结构化状态，未安装 gh 时明确提示可一键安装
- gh 可执行文件缓存：安装或退出后自动失效，下次调用重新探测

### 说明
- 面板样式自绘并沿用 Hana 主题令牌（`--bg-card` / `--accent` / `--font-ui` 等），随宿主主题自适应，不额外打包第三方组件库
- UI 冒烟校验（`--smoke`）需要独立 Electron 运行时；未配置 `HANA_APP_ELECTRON` 时该步跳过，静态校验与打包校验均通过

## [0.1.2] - 2026-09-27
### 新增
- **登录全程引导**：`github_cli_login` 返回结构化三步引导（授权页→输码→点 Authorize），并提醒助手在用户回复前不重复调用、完成后主动验证登录态；失败信息分类为「网络瞬时干扰可重跑」与「需人工介入」
- **子进程代理环境变量清洗**：起 `gh` 前统一清除 `HTTP_PROXY`/`HTTPS_PROXY`/`WS_PROXY`/`WSS_PROXY`/`ALL_PROXY` 等残留变量，落实「GitHub 直连」原则。背景：本机环境树残留死 SOCKS 变量，曾把设备码请求坑到超时
- 令牌登录成功后提示下一步（调 status 验证）；令牌无效时附带 PAT 生成页与 scope 建议

### 修复
- 设备码流程：拿到码后绝不杀子进程（gh 需持续轮询才能接住用户授权）；旧版在解析失败路径上存在重复判断与提前退出未处理问题

## [0.1.1] - 2026-09-27

### 修复
- 设备码登录：适配 gh 2.101 的输出格式（`One-time code (XXXX-XXXX) copied to clipboard`），旧正则只匹配 `one-time code: XXXX-XXXX` 导致解析失败
- 状态诊断：去掉误传的 `-h` 参数（gh 的 `-h` 是 `--hostname` 需要带值，导致 auth status 直接报错）

### 变更
- 清单补充 `description` 字段，扩展面板列表行可见应用简介

## [0.1.0] - 2026-09-27

### 新增
- 首个版本：将官方 GitHub CLI（gh）桥接为 Hana v2 App
- `github_cli_status`：gh 版本与登录状态一体诊断
- `github_cli_run`：通用 gh 命令执行桥（参数数组直传、无 shell 展开、元字符拒绝、超时与输出截断兜底）
- `github_cli_login`：token（stdin 直交 gh，不落盘）与 device（设备码流程）两种登录方式
- gh 可执行文件解析：`GH_CLI_PATH` → 平台默认安装路径 → `PATH`
