# GitHub CLI（Hana v2 App）

把官方 [GitHub CLI](https://cli.github.com)（`gh`）桥接为 Hana 工具，并提供一枚管理面板卡片。
顶层说明、安装方式与使用方法见仓库根目录的 [README.md](../README.md)。

## 目录

```
manifest.json      v2 清单：能力声明 + 管理面板卡片
index.js           入口：五个工具 + 面板后端路由 + 子进程编排
lib/gh-core.js     纯逻辑层（环境清洗 / 版本解析比对 / 登录态解析 / 设备码 / 镜像排序 / 提权命令），可单测
assets/icon.svg    应用图标
ui/
  panel.html       管理面板页面
  assets/panel.js  面板交互（单一 state + render，确认条也是状态）
  assets/panel.css 面板样式（沿用 Hana 主题令牌）
  assets/cover.svg 卡片封面（深色圆盘 + Octocat 剪影）
  assets/sdk.js    官方客户端桥 SDK（本地打包，运行时免依赖）
sdk/               官方服务端 App SDK（本地打包，运行时免依赖）
```

> 单元测试在仓库根的 `tests/gh-core.test.mjs`（不随包分发）：`node tests/gh-core.test.mjs`。

## 四条硬约束

- **主题跟随**：面板 iframe 的 URL 带 `hana-css`（当前主题完整 CSS）与 `hana-palette-{light,dark}-css`（auto 模式）；`panel.html` 读这些参数动态挂载主题。CSS 一律按 **`--hana-*`（custom 主题） → 旧主题名 → 默认值** 取值，否则自定义主题下不跟随
- **运行时目录必须落在 `ctx.dataDir`**：宿主以 Node 权限模型（`--permission --allow-fs-write=<dataDir>`）启动 App，写 `os.tmpdir()` 等外部路径会被 `ERR_ACCESS_DENIED` 拒绝。需要落盘时（下载安装包、缓存）一律写 `sdk.dataDir`
- **iframe 沙箱**：面板跑在沙箱 iframe 里，`window.confirm/alert` 被禁——需要确认时用面板内确认卡；打开外部链接由**后端**完成（`cmd /c start`），不用 `hana.external.open`
- **不做 shell 展开**：所有子进程走 `execFile`，参数以数组传递；`github_cli_run` 额外拒绝含 `<>|;&$`` ` 的参数
- **GitHub 直连**：起子进程前用 `cleanEnv()` 清除 `HTTP_PROXY` 等 8 个代理变量
- **设备码进程必须存活**：拿到码后 `unref()` 但不 kill，gh 需持续轮询才能接住用户的授权
- **MSI 装/卸必须提权**：走 `Start-Process -Verb RunAs` 触发 UAC，否则静默安装必然失败

## 后端（index.js）结构

按职责分区：常量 → 进程执行 → 状态 → 设备码 → 安装引擎 → 工具 → 路由。平台细节都在 `lib/gh-core.js`（纯函数，可单测）。

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
