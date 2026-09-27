// GitHub CLI 管理面板：安装 / 登录 / 退出 三段式交互。
// 数据面走 SDK 提供的 hana.api.fetch → /api/apps/github-cli/routes/*
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);

const els = {
  dot: $("health-dot"),
  appVersion: $("app-version"),
  startup: $("startup"),
  installSec: $("sec-install"),
  ghVersion: $("gh-version"),
  installAction: $("install-action"),
  installLog: $("install-log"),
  authSec: $("sec-auth"),
  authHint: $("auth-hint"),
  authBtnSlot: $("auth-btn-slot"),
  codeChip: $("device-code"),
  codeText: $("device-code-text"),
  steps: $("login-steps"),
  note: $("auth-note"),
  updated: $("updated"),
  refresh: $("refresh"),
};

let pollTimer = null;
let busy = false;

function setDot(state) {
  els.dot.dataset.state = state;
}

function button(label, { variant = "primary", onClick, disabled = false } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn" + (variant === "ghost" ? " btn--ghost" : "") + (variant === "danger" ? " btn--danger" : "");
  b.textContent = label;
  b.disabled = disabled;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function busyNode(label) {
  const wrap = document.createElement("span");
  wrap.className = "busy";
  const sp = document.createElement("span");
  sp.className = "spinner";
  const tx = document.createElement("span");
  tx.textContent = label;
  wrap.append(sp, tx);
  return wrap;
}

async function api(path, init) {
  const res = await hana.api.fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: false, error: text };
  }
  return { status: res.status, data };
}

/**
 * 三级兜底复制：宿主剪贴板 → 浏览器原生 → execCommand。
 * 任一层成功即返回方式名，全失败返回 null。
 */
async function copyText(text) {
  const value = String(text ?? "");
  if (!value) return null;
  // 1) Hana 宿主剪贴板（需 app/ui.clipboard-write）；短超时，避免按钮卡死
  try {
    await hana.clipboard.writeText(value, { timeoutMs: 2000 });
    return "host";
  } catch {
    /* 落到下一层 */
  }
  // 2) 浏览器原生异步剪贴板
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return "navigator";
    }
  } catch {
    /* 落到下一层 */
  }
  // 3) 兜底：临时 textarea + execCommand（旧内核/受限 iframe 常用）
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return "execCommand";
  } catch {
    /* 全部失败 */
  }
  return null;
}

/** 兜底提示：把代码放进可全选输入框，让用户手动 Ctrl+C。 */
function showManualCopy(text) {
  els.note.hidden = false;
  els.note.textContent = "自动复制被拦截，请按 Ctrl+C 复制：";
  let input = document.getElementById("manual-copy");
  if (!input) {
    input = document.createElement("input");
    input.id = "manual-copy";
    input.readOnly = true;
    input.className = "manual-copy";
    els.note.after(input);
  }
  input.value = text;
  input.hidden = false;
  input.focus();
  input.select();
}

function renderInstall(state) {
  els.installSec.hidden = false;
  const gh = state.gh || {};
  els.ghVersion.textContent = gh.installed ? `已安装 · ${gh.version || "版本未知"}` : "未安装";
  els.installAction.textContent = "";

  const inst = state.install || {};
  if (gh.installed) {
    els.installAction.append(
      button("重新安装", {
        variant: "ghost",
        disabled: !!inst.running,
        onClick: () => startInstall(),
      }),
    );
    if (!inst.log) els.installLog.hidden = true;
  } else if (inst.running) {
    els.installAction.append(busyNode("正在安装…"));
  } else {
    els.installAction.append(button("一键安装", { onClick: () => startInstall() }));
  }

  if (inst.done && inst.log) {
    els.installLog.hidden = false;
    els.installLog.textContent = inst.log.slice(-4000);
  } else if (!inst.done) {
    els.installLog.hidden = true;
  }
  if (inst.error) {
    els.note.hidden = false;
    els.note.textContent = inst.error;
  }
}

function renderAuth(state) {
  els.authSec.hidden = false;
  const auth = state.auth || {};
  const acc = auth.account;
  const device = state.device || {};
  els.authBtnSlot.textContent = "";
  els.codeChip.hidden = true;

  if (auth.loggedIn && acc) {
    setDot("ok");
    els.authHint.textContent = `${acc.login} @ ${acc.host}　·　${acc.protocol || "https"}　·　${acc.scopes || "scope 未报告"}`;
    els.authBtnSlot.append(
      button("退出登录", {
        variant: "danger",
        disabled: busy,
        onClick: async () => {
          if (!window.confirm(`确认退出 ${acc.login} 的登录？\n（只删本地凭据，不影响远端令牌）`)) return;
          busy = true;
          render();
          const { data } = await api("/logout", { method: "POST" });
          busy = false;
          if (!data?.ok) {
            els.note.hidden = false;
            els.note.textContent = `退出失败：${data?.output || "未知错误"}`;
          }
          refresh();
        },
      }),
    );
    els.steps.hidden = true;
  } else {
    setDot(device.active ? "warn" : "off");
    els.authHint.textContent = device.active ? "等待授权中…" : "未登录";
    els.authBtnSlot.append(
      button(device.active ? "重新获取代码" : "登录", {
        variant: device.active ? "ghost" : "primary",
        disabled: busy,
        onClick: () => startLogin(),
      }),
    );
    if (device.active) {
      els.codeChip.hidden = false;
      els.codeText.textContent = device.code;
      els.steps.hidden = false;
    } else {
      els.steps.hidden = true;
    }
  }
}

function render(state) {
  els.appVersion.textContent = `v${state.version || "—"}`;
  els.startup.textContent = "";
  els.note.hidden = true;
  renderInstall(state);
  renderAuth(state);
  els.updated.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
}

async function refresh() {
  try {
    const { data } = await api("/status");
    if (data?.ok) {
      render(data);
      schedulePoll(data);
    } else {
      els.startup.textContent = "读取状态失败，稍后自动重试。";
    }
  } catch (error) {
    els.startup.textContent = `无法连接应用后端：${error?.message ?? error}`;
  }
}

function schedulePoll(state) {
  const active = state?.device?.active || state?.install?.running;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (active) {
    pollTimer = setTimeout(refresh, 2500);
  }
}

async function startInstall() {
  els.note.hidden = true;
  const { data } = await api("/install", { method: "POST" });
  if (data?.message) {
    els.startup.textContent = data.message;
  }
  refresh();
}

async function startLogin() {
  busy = true;
  els.note.hidden = true;
  render({ version: els.appVersion.textContent.replace(/^v/, ""), gh: { installed: true }, auth: { loggedIn: false }, install: {} });
  try {
    const { data } = await api("/login/device", { method: "POST" });
    if (!data?.ok) {
      els.note.hidden = false;
      els.note.textContent = `获取设备码失败：${data?.error || "未知错误"}。GitHub 直连偶发抖动，再点一次即可。`;
    }
  } catch (error) {
    els.note.hidden = false;
    els.note.textContent = `获取设备码失败：${error?.message ?? error}`;
  }
  busy = false;
  refresh();
}

els.codeChip.addEventListener("click", async () => {
  const code = els.codeText.textContent.trim();
  if (!code) return;
  const tip = els.codeChip.querySelector(".code-chip__tip");
  const how = await copyText(code);
  if (how) {
    els.codeChip.dataset.copied = "1";
    if (tip) tip.textContent = "已复制";
    const manual = document.getElementById("manual-copy");
    if (manual) manual.hidden = true;
    setTimeout(() => {
      els.codeChip.dataset.copied = "0";
      if (tip) tip.textContent = "复制";
    }, 1800);
  } else {
    showManualCopy(code);
  }
});

els.refresh.addEventListener("click", () => refresh());

// iframe 内 target="_blank" 不可靠，授权页链接交给宿主的外部打开能力
const deviceLink = document.querySelector('#login-steps a');
if (deviceLink) {
  deviceLink.removeAttribute('target');
  deviceLink.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await hana.external.open('https://github.com/login/device');
    } catch {
      els.note.hidden = false;
      els.note.textContent = '打开浏览器失败，请手动访问 https://github.com/login/device';
    }
  });
}

hana.ready();
refresh();
