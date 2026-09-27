// GitHub CLI 管理面板：安装 / 登录 / 退出 三段式交互。
// 数据面：hana.api.fetch → /api/apps/github-cli/routes/*
// 渲染模型：单一 state 对象 + 一个 render()，所有 UI 变化都经它落地。
import { hana } from "./sdk.js";

const ROUTE = {
  status: "/status",
  install: "/install",
  login: "/login/device",
  logout: "/logout",
};

const POLL_INTERVAL_MS = 2500;
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
  installLog: el("install-log"),
  authSection: el("sec-auth"),
  authHint: el("auth-hint"),
  authAction: el("auth-btn-slot"),
  codeChip: el("device-code"),
  codeChipText: el("device-code-text"),
  codeChipTip: document.querySelector(".code-chip__tip"),
  steps: el("login-steps"),
  note: el("auth-note"),
  updated: el("updated"),
  refresh: el("refresh"),
};

/** 当前面板状态：由 /status 返回值与本地动作共同维护。 */
let state = { version: null, gh: {}, auth: {}, install: {}, device: {} };
let pendingAction = null; // "install" | "login" | "logout" | null
let pollTimer = null;

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

function makeButton(label, { variant = "primary", onClick, disabled = false } = {}) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = ["btn", variant === "ghost" && "btn--ghost", variant === "danger" && "btn--danger"]
    .filter(Boolean)
    .join(" ");
  node.textContent = label;
  node.disabled = disabled;
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
  ui.note.hidden = !message;
  ui.note.textContent = message || "";
}

function setDot(kind) {
  ui.dot.dataset.state = kind;
}

// ---------------------------------------------------------------- 复制（三级兜底）

/**
 * 复制文本：宿主剪贴板 → 浏览器原生 → execCommand。
 * 返回成功的层级名，全失败返回 null。
 */
async function copyText(value) {
  const data = String(value ?? "");
  if (!data) return null;

  try {
    await hana.clipboard.writeText(data, { timeoutMs: 2000 });
    return "host";
  } catch {
    /* 落下一级 */
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(data);
      return "navigator";
    }
  } catch {
    /* 落下一级 */
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

/** 自动复制被拦截时，给一个已全选的输入框让用户手动 Ctrl+C。 */
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

function hideManualCopy() {
  const field = el("manual-copy");
  if (field) field.hidden = true;
}

// ---------------------------------------------------------------- 渲染

function renderInstall() {
  const { installed, version } = state.gh;
  const install = state.install;

  ui.installSection.hidden = false;
  ui.ghVersion.textContent = installed ? `已安装 · ${version || "版本未知"}` : "未安装";
  ui.installAction.textContent = "";

  if (install.running) {
    ui.installAction.append(makeBusy("正在安装…"));
  } else if (installed) {
    ui.installAction.append(makeButton("重新安装", { variant: "ghost", onClick: requestInstall }));
  } else {
    ui.installAction.append(makeButton("一键安装", { onClick: requestInstall }));
  }

  const showLog = !!(install.done && install.log);
  ui.installLog.hidden = !showLog;
  if (showLog) ui.installLog.textContent = install.log.slice(-LOG_TAIL_CHARS);
}

function renderAuth() {
  const { loggedIn, account } = state.auth;
  const device = state.device;

  ui.authSection.hidden = false;
  ui.authAction.textContent = "";
  ui.codeChip.hidden = true;

  if (loggedIn && account) {
    setDot("ok");
    ui.authHint.textContent = `${account.login} @ ${account.host}　·　${account.protocol || "https"}　·　${account.scopes || "scope 未报告"}`;
    ui.authAction.append(
      makeButton("退出登录", { variant: "danger", disabled: pendingAction === "logout", onClick: requestLogout }),
    );
    ui.steps.hidden = true;
    return;
  }

  const waiting = !!device.active;
  setDot(waiting ? "warn" : "off");
  ui.authHint.textContent = waiting ? "等待授权中…" : "未登录";
  ui.authAction.append(
    makeButton(waiting ? "重新获取代码" : "登录", {
      variant: waiting ? "ghost" : "primary",
      disabled: pendingAction === "login",
      onClick: requestLogin,
    }),
  );

  ui.codeChip.hidden = !waiting;
  if (waiting) {
    ui.codeChipText.textContent = device.code;
    ui.steps.hidden = false;
  } else {
    ui.steps.hidden = true;
  }
}

function render() {
  ui.appVersion.textContent = `v${state.version || "—"}`;
  ui.startup.textContent = "";
  renderInstall();
  renderAuth();
  ui.updated.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
}

// ---------------------------------------------------------------- 数据刷新

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;

  const busy = state.install.running || state.device.active;
  if (busy) pollTimer = setTimeout(refresh, POLL_INTERVAL_MS);
}

async function refresh() {
  try {
    const { data } = await api(ROUTE.status);
    if (!data?.ok) {
      ui.startup.textContent = "读取状态失败，稍后自动重试。";
      return;
    }
    state = {
      version: data.version,
      gh: data.gh || {},
      auth: data.auth || {},
      install: data.install || {},
      device: data.device || {},
    };
    render();
    if (state.install.error) setNote(state.install.error);
    schedulePoll();
  } catch (error) {
    ui.startup.textContent = `无法连接应用后端：${error?.message ?? error}`;
  }
}

// ---------------------------------------------------------------- 动作

async function requestInstall() {
  setNote("");
  hideManualCopy();
  await api(ROUTE.install, { method: "POST" });
  refresh();
}

async function requestLogout() {
  const login = state.auth.account?.login;
  if (!window.confirm(`确认退出 ${login} 的登录？\n（只删本地凭据，不影响远端令牌）`)) return;
  pendingAction = "logout";
  render();
  setNote("");
  const { data } = await api(ROUTE.logout, { method: "POST" });
  pendingAction = null;
  if (!data?.ok) setNote(`退出失败：${data?.output || "未知错误"}`);
  refresh();
}

async function requestLogin() {
  pendingAction = "login";
  setNote("");
  hideManualCopy();
  render();
  try {
    const { data } = await api(ROUTE.login, { method: "POST" });
    if (!data?.ok) {
      setNote(`获取设备码失败：${data?.error || "未知错误"}。GitHub 直连偶发抖动，再点一次即可。`);
    }
  } catch (error) {
    setNote(`获取设备码失败：${error?.message ?? error}`);
  }
  pendingAction = null;
  refresh();
}

// ---------------------------------------------------------------- 事件绑定

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

ui.refresh.addEventListener("click", () => refresh());

// iframe 内 target="_blank" 不可靠，授权页链接交给宿主的外部打开能力
const deviceLink = document.querySelector("#login-steps a");
if (deviceLink) {
  deviceLink.removeAttribute("target");
  deviceLink.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await hana.external.open("https://github.com/login/device");
    } catch {
      setNote("打开浏览器失败，请手动访问 https://github.com/login/device");
    }
  });
}

hana.ready();
refresh();
