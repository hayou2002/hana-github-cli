// 纯逻辑与平台适配层：不依赖 App 运行时，可被 Node 直接 import 做单元测试。
// index.js 只负责与宿主 SDK 打交道，平台细节都落在这里。

// ---------------------------------------------------------------- 常量

/** 残留代理变量：子进程前一律剔除，保证 GitHub 直连。 */
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "WS_PROXY",
  "WSS_PROXY",
  "ALL_PROXY",
  "all_proxy",
];

export const GH_HOST = "github.com";
export const GH_REPO = "cli/cli";
export const DEVICE_URL = "https://github.com/login/device";
export const GH_DOWNLOAD_URL = "https://github.com/cli/cli/releases/latest";

/** 下载加速候选：空串表示直连。 */
export const GH_MIRRORS = ["", "https://gh-proxy.com/", "https://ghproxy.net/", "https://ghfast.top/"];

// ---------------------------------------------------------------- 环境

/** 剔除残留代理变量（GitHub 直连原则）。返回新对象，不改原 env。 */
export function cleanEnv(base = {}) {
  const env = { __proto__: null, ...base };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return env;
}

/** gh 可执行文件的候选路径（按优先级）。 */
export function ghExecutableCandidates(env = {}, platform = process.platform) {
  const candidates = [];
  if (env.GH_CLI_PATH) candidates.push(env.GH_CLI_PATH);
  if (platform === "win32") {
    candidates.push("C:/Program Files/GitHub CLI/gh.exe");
    if (env.LOCALAPPDATA) candidates.push(`${env.LOCALAPPDATA}/Programs/GitHub CLI/gh.exe`);
  } else {
    if (env.HOME) candidates.push(`${env.HOME}/.local/bin/gh`);
    candidates.push("/usr/local/bin/gh", "/opt/homebrew/bin/gh");
  }
  candidates.push("gh");
  return [...new Set(candidates.filter(Boolean))];
}

// ---------------------------------------------------------------- 文本

export function clip(text, max = 60_000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[输出已截断：共 ${value.length} 字符，保留前 ${max} 字符。可用 --jq/--limit 收窄结果。]`;
}

// ---------------------------------------------------------------- 版本

/** 从 `gh version 2.101.0 (2026-09-15)` 里取纯语义化版本号；失败返回 null。 */
export function parseGhVersion(output) {
  const m = String(output ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** 比较语义化版本：a>b 返回 1，a<b 返回 -1，相等返回 0。非法输入按 0 处理。 */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ---------------------------------------------------------------- gh 输出解析

/** 解析 `gh auth status --json hosts` 的输出，返回登录态与活动账号。 */
export function parseAuthStatus(json) {
  let hosts = {};
  try {
    hosts = JSON.parse(String(json ?? "{}")).hosts || {};
  } catch {
    hosts = {};
  }
  const accounts = Object.values(hosts)
    .flat()
    .filter((a) => a && a.state === "success");
  const account = accounts.find((a) => a.active) || accounts[0] || null;
  return {
    loggedIn: !!account,
    account: account
      ? {
          host: account.host || GH_HOST,
          login: account.login || "",
          scopes: account.scopes || "",
          tokenSource: account.tokenSource || "",
          protocol: account.gitProtocol || "",
        }
      : null,
  };
}

/** 从 gh 的设备码输出里提取一次性代码；无则返回 null。 */
export function extractDeviceCode(buffer) {
  const m = String(buffer ?? "").match(/one[-\s]?time code[^0-9A-Z]*([0-9A-Z]{4}-[0-9A-Z]{4})/i);
  return m ? m[1] : null;
}

/** 从 gh 的输出判断失败是不是网络层原因。 */
export function looksLikeNetworkFailure(buffer) {
  return /failed to authenticate|wsarecv|connection|timed out|refused|reset/i.test(String(buffer ?? ""));
}

// ---------------------------------------------------------------- 下载与镜像

export function msiUrl(version, mirror = "") {
  return `${mirror}https://github.com/${GH_REPO}/releases/download/v${version}/gh_${version}_windows_amd64.msi`;
}

export function mirrorLabel(mirror) {
  if (!mirror) return "直连";
  try {
    return new URL(mirror).hostname;
  } catch {
    return mirror;
  }
}

/** 按速度降序排列可用镜像；无法解析速度的条目丢弃。 */
export function rankMirrorResults(results) {
  return results.filter((r) => r && Number.isFinite(r.speed) && r.speed > 0).sort((a, b) => b.speed - a.speed);
}

// ---------------------------------------------------------------- Windows 提权

/**
 * 构造“以管理员身份运行”的 PowerShell 命令（触发 UAC）。
 * 返回命令体字符串，供 `powershell.exe -NoProfile -Command <cmd>` 使用。
 * 仅 Windows 有意义；其他平台由调用方（runElevated）先行拦截。
 */
export function buildElevateCommand(exe, args, { wait = true } = {}) {
  const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // 关键：Start-Process 的 -ArgumentList 传“数组”时，PS 5.1 只用空格拼接，
  // 含空格的参数会被拆散（路径常见，如 C:\Users\Zhang San\...）。
  // 因此先把单个参数按 Windows 命令行规则加双引号，再拼成一整条字符串传入。
  const winQuote = (s) => {
    const str = String(s);
    return /[\s"]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
  };
  const argString = args.map(winQuote).join(" ");
  return [
    `$p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${psQuote(argString)} -Verb RunAs`,
    wait ? "-Wait -PassThru" : "-PassThru",
    "; if ($null -eq $p) { exit 1 }; if (" + (wait ? "$p.HasExited" : "$false") + ") { exit $p.ExitCode } else { exit 0 }",
  ].join(" ");
}

/** 从注册表卸载项里定位 GitHub CLI 的产品码（GUID）；找不到返回 null。 */
export function parseProductCode(regOutput) {
  const m = String(regOutput ?? "").match(/\{[0-9A-Fa-f-]{36}\}/);
  return m ? m[0] : null;
}

export const UNINSTALL_QUERY = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); " +
    "Get-ChildItem $paths -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } | " +
    "Where-Object { $_.DisplayName -like 'GitHub CLI*' } | Select-Object -First 1 -ExpandProperty PSChildName",
];
