// GitHub CLI 管理面板：安装 / 登录 / 退出。
// 数据面：hana.api.fetch → /api/apps/github-cli/routes/*
// 渲染模型：单一 state + 单一 render()，所有 UI 变化都经它落地。
// 注意：面板跑在 iframe 里 —— window.confirm/alert 被沙箱禁止，浏览器打开改由后端完成。
import { hana } from "./sdk.js";

const ROUTE = {
  status: "/status",
  job: "/job",
  clearLog: "/clear-log",
  login: "/login/device",
  logout: "/logout",
  openDevice: "/open-device",
};
const POLL_JOB_MS = 1200; // 任务进行中
const POLL_WAIT_MS = 4000; // 等待授权
const LOG_TAIL_CHARS = 4000;
const CODE_COPIED_RESET_MS = 1800;

const el = (id) => document.getElementById(id);

const ui = {
  dot: el("health-dot"),
  appVersion: el("app-version"),
  startup: el("startup"),
  installSection: el("sec-install"),
  ghVersion: el("gh-version"),
  installAction: el("install-action"),
  progressWrap: el("job-progress"),
  progressFill: el("job-fill"),
  jobPhase: el("job-phase"),
  logWrap: el("job-log-wrap"),
  logClear: el("log-clear"),
  log: el("job-log"),
  authSection: el("sec-auth"),
  authHint: el("auth-hint"),
  authAction: el("auth-action"),
  codeRow: el("code-row"),
  codeChip: el("device-code"),
  codeChipText: el("device-code-text"),
  codeChipTip: document.querySelector(".code-chip__tip"),
  steps: el("login-steps"),
  deviceLink: el("device-link"),
  confirmBar: el("confirm-bar"),
  confirmText: el("confirm-text"),
  confirmOk: el("confirm-ok"),
  confirmCancel: el("confirm-cancel"),
  note: el("auth-note"),
  updated: el("updated"),
  refresh: el("refresh"),
};

let state = { version: null, gh: {}, auth: {}, job: {}, device: {} };
let pending = null; // "login" | "logout" | null
let pollTimer = null;
// 确认条也是状态：{ message, onOk } | null。render() 幂等，不靠副作用开合。
let confirmRequest = null;

// ---------------------------------------------------------------- 基础件

async function api(path, init) {
  const res = await hana.api.fetch(path, init);
  const raw = await res.text();
  try {
    return { status: res.status, data: raw ? JSON.parse(raw) : null };
  } catch {
    return { status: res.status, data: { ok: false, error: raw } };
  }
}

const apiPost = (path, body) =>
  api(path, {
    method: "POST",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

function makeButton(label, { variant = "primary", onClick, disabled = false, title } = {}) {
  const node = document.createElement("button");
  node.type = "button";
  // primary=实心主色（一张卡只该有一个）；ghost=次要；danger=描边危险（不抢主操作的权重）
  const variantClass = { primary: "", ghost: "btn--ghost", danger: "btn--danger", dangerSolid: "btn--danger-solid" }[variant];
  node.className = ["btn", variantClass].filter(Boolean).join(" ");
  node.textContent = label;
  node.disabled = disabled;
  if (title) node.title = title;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function makeBusy(label) {
  const wrap = document.createElement("span");
  wrap.className = "busy";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  const node = document.createElement("span");
  node.textContent = label;
  wrap.append(spinner, node);
  return wrap;
}

function setNote(message) {
  ui.note.textContent = message || "";
  ui.note.hidden = !message;
}

function askConfirm(message, onOk) {
  confirmRequest = { message, onOk };
  render();
}

function clearConfirm() {
  confirmRequest = null;
  render();
}

// ---------------------------------------------------------------- 复制（三级兜底）

async function copyText(value) {
  const data = String(value ?? "");
  if (!data) return null;

  try {
    await hana.clipboard.writeText(data, { timeoutMs: 2000 });
    return "host";
  } catch {
    /* 下一级 */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(data);
      return "navigator";
    }
  } catch {
    /* 下一级 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = data;
    area.readOnly = true;
    area.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, data.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    if (ok) return "execCommand";
  } catch {
    /* 全部失败 */
  }
  return null;
}

function offerManualCopy(value) {
  let field = el("manual-copy");
  if (!field) {
    field = document.createElement("input");
    field.id = "manual-copy";
    field.readOnly = true;
    field.className = "manual-copy";
    ui.note.after(field);
  }
  setNote("自动复制被拦截，请按 Ctrl+C 复制：");
  field.value = value;
  field.hidden = false;
  field.focus();
  field.select();
}

const hideManualCopy = () => {
  const field = el("manual-copy");
  if (field) field.hidden = true;
};

// ---------------------------------------------------------------- 渲染

/** 健康点：由整体就绪度决定，不被某一分区“顺手”改写。 */
function renderHealth() {
  const { installed } = state.gh;
  const { loggedIn } = state.auth;
  const waiting = !!state.device.active;
  const level = !installed ? "off" : loggedIn ? "ok" : waiting ? "warn" : "off";
  ui.dot.dataset.state = level;
  ui.dot.title = !installed ? "未安装" : loggedIn ? "已就绪" : waiting ? "等待授权" : "未登录";
}

function renderInstall() {
  const { installed, version } = state.gh;
  const job = state.job;

  ui.installSection.hidden = false;
  ui.ghVersion.textContent = installed ? `已安装 · ${version || "版本未知"}` : "未安装";
  ui.installAction.textContent = "";

  if (job.running) {
    // 阶段名由下方进度行承载，这里只留通用忙碌提示，避免同一句出现两次
    ui.installAction.append(makeBusy("处理中…"));
  } else if (installed) {
    // 三个按钮：升级 / 重装 / 卸载
    ui.installAction.append(
      makeButton("升级", { onClick: () => requestJob("upgrade") }),
      makeButton("重装", { variant: "ghost", onClick: () => requestJob("install") }),
      makeButton("卸载", { variant: "danger", onClick: confirmUninstall }),
    );
  } else {
    ui.installAction.append(makeButton("一键安装", { onClick: () => requestJob("install") }));
  }

  // 进度条：仅任务进行中显示
  ui.progressWrap.hidden = !job.running;
  if (job.running) {
    const pct = typeof job.percent === "number" ? job.percent : null;
    ui.progressFill.style.width = pct == null ? "100%" : `${pct}%`;
    ui.progressFill.classList.toggle("is-indeterminate", pct == null);
    ui.jobPhase.textContent = [job.phase, job.source && `源：${job.source}`, pct != null && `${pct.toFixed(0)}%`]
      .filter(Boolean)
      .join(" · ");
  }

  // 日志：任务进行中或刚结束且有内容时显示
  const showLog = !!(job.log && (job.running || job.done));
  ui.logWrap.hidden = !showLog;
  if (showLog) {
    ui.log.textContent = job.log.slice(-LOG_TAIL_CHARS);
    ui.log.scrollTop = ui.log.scrollHeight;
  }
}

function renderAuth() {
  const { loggedIn, account } = state.auth;
  const device = state.device;

  ui.authSection.hidden = false;
  ui.authAction.textContent = "";

  if (loggedIn && account) {
    // 已登录：显示账号 + 退出登录；代码行/步骤/复制一律隐藏
    ui.authHint.textContent = `${account.login} @ ${account.host}　·　${account.protocol || "https"}　·　${account.scopes || "scope 未报告"}`;
    ui.authAction.append(makeButton("退出登录", { variant: "danger", disabled: pending === "logout", onClick: confirmLogout }));
    ui.codeRow.hidden = true;
    ui.steps.hidden = true;
    return;
  }

  const waiting = !!device.active;
  ui.authHint.textContent = waiting ? "等待授权中…" : "未登录";
  ui.authAction.append(
    makeButton(waiting ? "重新获取代码" : "登录", {
      variant: waiting ? "ghost" : "primary",
      disabled: pending === "login",
      onClick: requestLogin,
    }),
  );

  // 未登录且未在等待时才隐藏代码/步骤（等待中才需要它们）
  ui.codeRow.hidden = !waiting;
  ui.steps.hidden = !waiting;
  if (waiting) ui.codeChipText.textContent = device.code;
}

/** 确认条：纯状态驱动，轮询刷新不会把它抹掉。 */
function renderConfirm() {
  const active = !!confirmRequest;
  ui.confirmBar.hidden = !active;
  if (active) ui.confirmText.textContent = confirmRequest.message;
}

function render() {
  ui.appVersion.textContent = `v${state.version || "—"}`;
  ui.startup.textContent = "";
  renderHealth();
  renderInstall();
  renderAuth();
  renderConfirm();
  if (state.job.error) setNote(state.job.error);
  ui.updated.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
}

// ---------------------------------------------------------------- 刷新

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (state.job.running) pollTimer = setTimeout(refresh, POLL_JOB_MS);
  else if (state.device.active) pollTimer = setTimeout(refresh, POLL_WAIT_MS);
}

async function refresh() {
  try {
    const { data } = await api(ROUTE.status);
    if (!data?.ok) {
      ui.startup.textContent = "读取状态失败，稍后自动重试。";
      return;
    }
    state = { version: data.version, gh: data.gh || {}, auth: data.auth || {}, job: data.job || {}, device: data.device || {} };
    render();
    schedulePoll();
  } catch (error) {
    ui.startup.textContent = `无法连接应用后端：${error?.message ?? error}`;
  }
}

// ---------------------------------------------------------------- 动作

async function requestJob(action) {
  setNote("");
  clearConfirm();
  await apiPost(ROUTE.job, { action });
  refresh();
}

const confirmUninstall = () =>
  askConfirm("确认卸载 GitHub CLI（gh）？卸载后所有 gh 命令将不可用。", () => {
    clearConfirm();
    requestJob("uninstall");
  });

const confirmLogout = () =>
  askConfirm(`确认退出 ${state.auth.account?.login} 的登录？（只删本地凭据，不影响远端令牌）`, doLogout);

async function doLogout() {
  clearConfirm();
  pending = "logout";
  setNote("");
  render();
  const { data } = await apiPost(ROUTE.logout);
  pending = null;
  if (!data?.ok) setNote(`退出失败：${data?.output || "未知错误"}`);
  refresh();
}

async function requestLogin() {
  pending = "login";
  setNote("");
  hideManualCopy();
  render();
  try {
    const { data } = await apiPost(ROUTE.login);
    if (!data?.ok) {
      setNote(`获取设备码失败：${data?.error || "未知错误"}。GitHub 直连偶发抖动，再点一次即可。`);
    } else if (data.browserOpened === false) {
      setNote("浏览器未能自动打开，请点下方链接手动打开授权页。");
    }
  } catch (error) {
    setNote(`获取设备码失败：${error?.message ?? error}`);
  }
  pending = null;
  refresh();
}

// ---------------------------------------------------------------- 事件

ui.codeChip.addEventListener("click", async () => {
  const code = ui.codeChipText.textContent.trim();
  if (!code) return;
  const how = await copyText(code);
  if (!how) {
    offerManualCopy(code);
    return;
  }
  hideManualCopy();
  ui.codeChip.dataset.copied = "1";
  if (ui.codeChipTip) ui.codeChipTip.textContent = "已复制";
  setTimeout(() => {
    ui.codeChip.dataset.copied = "0";
    if (ui.codeChipTip) ui.codeChipTip.textContent = "复制";
  }, CODE_COPIED_RESET_MS);
});

ui.logClear.addEventListener("click", async () => {
  await apiPost(ROUTE.clearLog);
  refresh();
});

ui.confirmOk.addEventListener("click", () => {
  const handler = confirmRequest?.onOk;
  clearConfirm();
  if (handler) handler();
});

ui.confirmCancel.addEventListener("click", clearConfirm);

ui.refresh.addEventListener("click", () => refresh());

// 授权页链接：由后端打开（iframe 内 hana.external.open 与 target=_blank 都不可靠）
ui.deviceLink.addEventListener("click", async (event) => {
  event.preventDefault();
  await apiPost(ROUTE.openDevice);
});

hana.ready();

// 打开面板时先清掉上次任务的日志残留（任务进行中后端会忽略），再拉状态
(async () => {
  await apiPost(ROUTE.clearLog).catch(() => {});
  refresh();
})();
