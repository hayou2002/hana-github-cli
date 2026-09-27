# GitHub CLI（Hana v2 App）

把官方 [GitHub CLI](https://cli.github.com)（`gh`）桥接为 Hana 工具，并提供一枚管理面板卡片。
顶层说明、安装方式与使用方法见仓库根目录的 [README.md](../README.md)。

## 目录

```
manifest.json      v2 清单：能力声明 + 管理面板卡片
index.js           入口：五个工具 + 面板后端路由
assets/icon.svg    应用图标
ui/
  panel.html       管理面板页面
  assets/panel.js  面板交互（单一 state + render）
  assets/panel.css 面板样式（沿用 Hana 主题令牌）
  assets/cover.svg 卡片封面（contributes.cards[].face.image）
  assets/sdk.js    官方客户端桥 SDK（本地打包，运行时免依赖）
sdk/               官方服务端 App SDK（本地打包，运行时免依赖）
```

## 后端（index.js）结构

按职责分区，便于定位：

1. **常量** —— 版本、超时、限制、下载页
2. **环境与路径** —— `cleanEnv()`（剔除残留代理变量）、gh 候选路径、`clip()`、`openInBrowser()`
3. **结果封装** —— `text()` / `fail()` / `combine()`
4. **进程执行** —— 统一执行器 `run()`、`resolveGh()`、`gh()`、`describe()`
5. **状态读取** —— `readEnvironment()`：一次拿到「是否安装 + 版本 + 登录账号」
6. **设备码流程** —— `startDeviceFlow()` / `activeDeviceFlow()` / `loginWithToken()`
7. **安装管理** —— `startInstall()`（幂等，共享 Promise）
8. **工具注册** —— status / run / install / login / logout
9. **面板路由** —— `GET /status`、`POST /install|/login/device|/logout|/open-device`

### 两条硬约束

- **不做 shell 展开**：所有子进程走 `execFile`，参数以数组传递；`github_cli_run` 额外拒绝含 `<>|;&$`` ` 的参数
- **GitHub 直连**：起子进程前用 `cleanEnv()` 清除 `HTTP_PROXY` 等 8 个代理变量
- **设备码进程必须存活**：拿到码后 `unref()` 但不 kill，gh 需持续轮询才能接住用户的授权

## 前端（ui/）结构

- 数据面：`hana.api.fetch` → `/api/apps/github-cli/routes/*`
- 渲染：单一 `state` 对象 + 单一 `render()`；活动中的安装/授权按 2.5s 轮询
- 复制一次性代码：三级兜底（宿主剪贴板 → `navigator.clipboard` → `execCommand`），全失败给可全选输入框
- 打开授权页：`hana.external.open`（iframe 内 `target="_blank"` 不可靠）

## 校验与打包

```bash
node <skills>/hana-app-creator/scripts/validate_app.mjs --dir . --json
node <skills>/hana-app-creator/scripts/pack_app.mjs --dir . --publisher "快乐小猫" --out ./dist-extensions
```

> 带 `--smoke` 的 UI 冒烟需要独立 Electron 运行时（`HANA_APP_ELECTRON`）；未配置时跳过，静态校验不受影响。
