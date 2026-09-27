# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-09-27

### 新增
- **登录全程引导**：`github_cli_login` 返回结构化三步引导（授权页→输码→点 Authorize），并提醒助手在用户回复前不重复调用、完成后主动验证登录态；失败信息分类为「网络瞬时干扰可重跑」与「需人工介入」
- **子进程代理环境变量清洗**：起 `gh` 前统一清除 `HTTP_PROXY`/`HTTPS_PROXY`/`WS_PROXY`/`WSS_PROXY`/`ALL_PROXY` 等残留变量，落实「GitHub 直连」原则。背景：本机环境树残留死 SOCKS 变量，曾把设备码请求坑到超时
- 令牌登录成功后提示下一步（调 status 验证）；令牌无效时附带 PAT 生成页与 scope 建议

### 修复
- 设备码流程：拿到码后绝不杀子进程（gh 需持续轮询才能接住用户授权）；旧版在解析失败路径上存在重复判断与提前退出未处理问题

## [0.1.1] - 2026-09-27

### 修复
- 设备码登录：适配 gh 2.101 的输出格式（`One-time code (XXXX-XXXX) copied to clipboard`），旧正则只匹配 `one-time code: XXXX-XXXX` 导致解析失败。首个真实用户（作者本人的助手）上传前发现并修复
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
