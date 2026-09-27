// GitHub CLI App — 把官方 gh 命令桥接为 Hana 工具，并提供一枚管理面板卡片。
// 设计对齐 jimeng-cli：清单声明 app/process.spawn，实体命令走 execFile（无 shell 展开）。
// v0.2.0 起新增：管理面板（contributes.cards + sdk.routes）与安装/退出工具。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const VERSION = "0.2.0";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 60_000;
const GH_DOWNLOAD_URL = "https://github.com/cli/cli/releases/latest";
const DEVICE_URL = "https://github.com/login/device";

// GitHub 直连原则（用户明确）：Hana 进程树可能残留陈旧的 SOCKS/HTTP 代理环境变量，
// 它们会把子进程的 GitHub 请求坑死。起 gh 子进程前统一清除。
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "WS_PROXY", "WSS_PROXY", "ALL_PROXY", "all_proxy"];
function cleanEnv(base = process.env) {
  const env = { __proto__: null, ...base };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return env;
}

function ghExecutableCandidates() {
  const candidates = [];
  if (process.env.GH_CLI_PATH) candidates.push(process.env.GH_CLI_PATH);
  if (process.platform === "win32") {
    candidates.push(path.resolve("C:/Program Files/GitHub CLI/gh.exe"));
    const local = process.env.LOCALAPPDATA;
    if (local) candidates.push(path.resolve(local, "..", "Programs", "GitHub CLI", "gh.exe"));
  } else {
    const home = process.env.HOME || "";
    if (home) candidates.push(path.join(home, ".local", "bin", "gh"));
    candidates.push("/usr/local/bin/gh", "/opt/homebrew/bin/gh");
  }
  candidates.push("gh");
  return [...new Set(candidates.filter(Boolean))];
}

function clip(text) {
  const value = String(text ?? "");
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  const head = value.slice(0, MAX_OUTPUT_CHARS);
  return `${head}\n\n[输出已截断：共 ${value.length} 字符，保留前 ${MAX_OUTPUT_CHARS} 字符。可用 --jq/--limit 收窄结果。]`;
}

function failurePayload(message, hint) {
  return {
    content: [{ type: "text", text: hint ? `${message}\n提示：${hint}` : message }],
    isError: true,
  };
}

function textPayload(text) {
  return { content: [{ type: "text", text }] };
}

/** Best-effort: open a URL in the OS default browser. Never throws. */
function openInBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { shell: false, detached: true, stdio: "ignore", env: cleanEnv() }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { shell: false, detached: true, stdio: "ignore", env: cleanEnv() }).unref();
    } else {
      spawn("xdg-open", [url], { shell: false, detached: true, stdio: "ignore", env: cleanEnv() }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

export const name = "github-cli";

import { defineApp } from "./sdk/app-contract/server-client.js";

export default defineApp(async (sdk) => {
  await sdk.logger.info(`github-cli ${VERSION} loaded`);

  const MISSING_HINT = "未检测到 GitHub CLI（gh）。可调用 github_cli_install 自动安装，或在终端执行：winget install --id GitHub.cli";

  let cachedExecutable = null;

  async function resolveGh() {
    if (cachedExecutable) return cachedExecutable;
    const candidates = ghExecutableCandidates();
    try {
      const info = await sdk.process.resolveExecutable({ candidates });
      if (info?.path) {
        cachedExecutable = info.path;
        return cachedExecutable;
      }
    } catch {
      // 宿主解析失败时退回候选名直接执行，由 spawn 错误兜底。
    }
    cachedExecutable = candidates[candidates.length - 1];
    return cachedExecutable;
  }

  async function runGh(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const command = await resolveGh();
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: cleanEnv(),
      });
      return { ok: true, stdout: clip(stdout), stderr: clip(stderr) };
    } catch (error) {
      if (error?.code === "ENOENT") {
        cachedExecutable = null;
        return { ok: false, missing: true };
      }
      const stdout = clip(error?.stdout ?? "");
      const stderr = clip(error?.stderr ?? "");
      const status = error?.killed ? "命令超时被终止" : `gh 退出码 ${error?.code ?? error?.signal ?? "未知"}`;
      return { ok: false, failed: true, status, stdout, stderr, message: String(error?.message ?? error) };
    }
  }

  /** 一次拿到「gh 是否可用 + 版本 + 登录账号」。面板与 status 工具共用。 */
  async function readEnvironment() {
    const version = await runGh(["--version"], { timeoutMs: 15_000 });
    if (version.missing || !version.ok) {
      return { installed: false, version: null, loggedIn: false, account: null };
    }
    const firstLine = (version.stdout || "").split("\n")[0] || "";
    const auth = await runGh(["auth", "status", "--json", "hosts"], { timeoutMs: 30_000 });
    let hosts = {};
    try {
      hosts = JSON.parse(auth.stdout || "{}").hosts || {};
    } catch {
      hosts = {};
    }
    const accounts = Object.values(hosts).flat().filter((a) => a && a.state === "success");
    const account = accounts.find((a) => a.active) || accounts[0] || null;
    return {
      installed: true,
      version: firstLine.replace(/^gh version\s*/i, "").trim() || firstLine,
      loggedIn: !!account,
      account: account
        ? {
            host: account.host || "github.com",
            login: account.login || "",
            scopes: account.scopes || "",
            tokenSource: account.tokenSource || "",
            protocol: account.gitProtocol || "",
          }
        : null,
    };
  }

  // ---- 安装状态（面板轮询用） ----
  let installState = { running: false, done: false, error: null, log: "", startedAt: null };

  async function installGhCli() {
    if (installState.running) return installState;
    installState = { running: true, done: false, error: null, log: "", startedAt: Date.now() };
    const args =
      process.platform === "win32"
        ? ["install", "--id", "GitHub.cli", "--accept-source-agreements", "--accept-package-agreements", "--silent"]
        : ["--version"];
    const command = process.platform === "win32" ? "winget" : "brew";
    const finalArgs = process.platform === "win32" ? args : ["install", "gh"];
    try {
      const { stdout, stderr } = await execFileAsync(command, finalArgs, {
        shell: false,
        timeout: 15 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: cleanEnv(),
      });
      // 装完清掉缓存，下次 resolveGh 重新探测
      cachedExecutable = null;
      const ok = /successfully installed|已成功安装/i.test(`${stdout}\n${stderr}`) || (await runGh(["--version"], { timeoutMs: 15_000 })).ok;
      installState = {
        running: false,
        done: true,
        error: ok ? null : "安装命令结束但未检测到 gh，请查看日志",
        log: clip([stdout, stderr].filter(Boolean).join("\n")) || "（无输出）",
        startedAt: installState.startedAt,
      };
    } catch (error) {
      const log = clip([error?.stdout, error?.stderr].filter(Boolean).join("\n") || String(error?.message ?? error));
      installState = {
        running: false,
        done: true,
        error: `安装失败：${error?.message ?? error}`,
        log,
        startedAt: installState.startedAt,
      };
    }
    return installState;
  }

  // ---- 设备码登录流程（面板与 login 工具共用；进程必须存活到授权完成） ----
  let deviceFlow = null; // { code, url, startedAt, child, error }

  async function startDeviceFlow({ openBrowser = false } = {}) {
    const command = await resolveGh();
    const child = spawn(command, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv(),
    });
    let buffer = "";
    child.stdout.on("data", (d) => (buffer += d));
    child.stderr.on("data", (d) => (buffer += d));
    child.on("close", () => {
      cachedExecutable = null;
      if (deviceFlow && deviceFlow.child === child) deviceFlow.closedAt = Date.now();
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("25 秒内未拿到设备码：对 github.com 的请求被瞬时干扰，重试即可（GitHub 直连，无需代理）")),
        25_000,
      );
      const onData = () => {
        const match = buffer.match(/one[-\s]?time code[^0-9A-Z]*([0-9A-Z]{4}-[0-9A-Z]{4})/i);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", () => {
        clearTimeout(timer);
        const netFail = /failed to authenticate|wsarecv|connection|timed out|refused|reset/i.test(buffer);
        reject(new Error(netFail ? `网络层失败（直连 github.com 瞬时不稳定）：${clip(buffer) || "无输出"}` : `gh 提前退出：${clip(buffer) || "无输出"}`));
      });
    }).catch((error) => ({ error: String(error?.message ?? error) }));
    if (typeof code === "object") {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      throw new Error(code.error);
    }
    // 关键：拿到码后绝不杀子进程。gh 必须持续轮询，才能接住用户的授权动作。
    child.unref();
    deviceFlow = { code, url: DEVICE_URL, startedAt: Date.now(), child, error: null };
    if (openBrowser) openInBrowser(DEVICE_URL);
    return deviceFlow;
  }

  // ==== 工具：状态 ====
  await sdk.tools.register({
    name: "github_cli_status",
    description:
      "查看本机 GitHub CLI 与登录状态：返回 gh 版本、登录账号、scope、协议。用于确认环境是否就绪，或诊断「连不上 GitHub」。无需参数。若未安装 gh，会提示可用 github_cli_install 一键安装。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const env = await readEnvironment();
      const lines = [`GitHub CLI App v${VERSION}`];
      if (!env.installed) {
        lines.push("gh：未安装");
        lines.push(`下一步：${MISSING_HINT}`);
        return textPayload(lines.join("\n"));
      }
      lines.push(`gh：${env.version || "（版本未知）"}`);
      if (env.loggedIn && env.account) {
        lines.push(`登录：✓ ${env.account.login} @ ${env.account.host}`);
        lines.push(`scope：${env.account.scopes || "（未报告）"}`);
        lines.push(`协议：${env.account.protocol || "https"}｜凭据：${env.account.tokenSource || "未知"}`);
        if (deviceFlow?.code && !deviceFlow.closedAt) lines.push("（面板里还有一个待完成的设备码授权流程）");
      } else {
        lines.push("登录：未登录");
        lines.push("下一步：调用 github_cli_login（mode=device 推荐）登录，或在应用管理面板点「登录」。");
      }
      return textPayload(lines.join("\n"));
    },
  });

  // ==== 工具：通用执行 ====
  await sdk.tools.register({
    name: "github_cli_run",
    description:
      "执行一条 gh 命令（参数以数组传递，不经过 shell，无通配/管道展开）。读操作可直接跑，例如 [\"repo\",\"list\",\"--limit\",\"20\"]、[\"pr\",\"list\",\"--repo\",\"owner/name\"]、[\"api\",\"repos/owner/name\"]、[\"issue\",\"create\",\"--repo\",\"...\"] 等。写操作（create/edit/merge/close/delete/push/release 等）请先把完整参数列表告知用户并获确认后再调用。可用 cwd 指定仓库目录（git 上下文相关命令需要）。",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "gh 之后的参数数组。不要包含 gh 本身，不要包含 shell 元字符。",
          minItems: 1,
        },
        cwd: { type: "string", description: "可选。运行目录（绝对路径），git 相关命令通常需要在仓库内。" },
        timeoutMs: { type: "number", description: `可选超时（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` },
      },
      required: ["args"],
    },
    execute: async ({ args, cwd, timeoutMs }) => {
      if (!Array.isArray(args) || args.length === 0) return failurePayload("args 必须是非空字符串数组。");
      const cleaned = args.map(String);
      if (cleaned[0].toLowerCase() === "gh") cleaned.shift();
      if (cleaned.some((a) => /[<>|;&$`]/.test(a))) {
        return failurePayload("参数含 shell 元字符，已拒绝。gh 子命令本身支持所需能力（如 --json/--jq/--web），无需管道。");
      }
      const command = await resolveGh();
      const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5_000), MAX_TIMEOUT_MS);
      try {
        const { stdout, stderr } = await execFileAsync(command, cleaned, {
          shell: false,
          timeout,
          maxBuffer: 16 * 1024 * 1024,
          env: cleanEnv(),
          ...(cwd ? { cwd: String(cwd) } : {}),
        });
        const body = [clip(stdout), stderr ? `[stderr]\n${clip(stderr)}` : ""].filter(Boolean).join("\n");
        return textPayload(`gh ${cleaned.join(" ")} 执行成功：\n\n${body || "（无输出）"}`);
      } catch (error) {
        if (error?.code === "ENOENT") {
          cachedExecutable = null;
          return failurePayload(MISSING_HINT);
        }
        const stdout = clip(String(error?.stdout ?? ""));
        const stderr = clip(String(error?.stderr ?? ""));
        const status = error?.killed ? "超时被终止" : `退出码 ${error?.code ?? error?.signal ?? "未知"}`;
        return failurePayload(
          `gh ${cleaned.join(" ")} 失败（${status}）。\n${[stdout, stderr].filter(Boolean).join("\n") || error?.message || ""}`,
          "gh 非零退出常因未登录、无权限或不在 git 仓库内；可先跑 github_cli_status 或补 cwd。",
        );
      }
    },
  });

  // ==== 工具：安装 gh ====
  await sdk.tools.register({
    name: "github_cli_install",
    description:
      "在本机安装 GitHub CLI（gh）。Windows 走 winget install --id GitHub.cli，macOS 走 brew install gh。安装可能耗时数分钟并弹出系统权限确认。装好后本应用会自动重新探测 gh。用于用户在 github_cli_status 里看到「gh 未安装」时。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const before = await readEnvironment();
      if (before.installed) {
        return textPayload(`gh 已安装（${before.version}），无需重复安装。下载页：${GH_DOWNLOAD_URL}`);
      }
      const state = await installGhCli();
      if (state.error) return failurePayload(state.error, `可手动安装：winget install --id GitHub.cli；或从 ${GH_DOWNLOAD_URL} 下载。\n日志：${state.log}`);
      const after = await readEnvironment();
      if (after.installed) {
        return textPayload(`GitHub CLI 安装成功：${after.version}\n下一步：调用 github_cli_login(mode=device) 登录，或打开应用管理面板点「登录」。`);
      }
      return failurePayload("安装命令已执行，但仍未探测到 gh。可能需要重开终端或重启 Hana 让 PATH 生效。", `日志：${state.log}`);
    },
  });

  // ==== 工具：登录 ====
  await sdk.tools.register({
    name: "github_cli_login",
    description:
      "登录 GitHub CLI（带阶段引导）。两种方式：1) mode=token：用户手边有 GitHub Personal Access Token 时用，经 stdin 直交 gh auth login --with-token，App 不落盘不回显。2) mode=device（默认推荐）：设备码流程，本工具启动后台轮询进程并拿到一次性代码，返回值包含代码、授权页链接和三行用户操作引导，请把引导原样转告用户；后台进程保持存活直到授权完成或代码过期（约 15 分钟）。无论哪种方式，完成后都应主动调用 github_cli_status 验证并告知结果；拿不准就选 device。注意：GitHub 直连偶发瞬时干扰，设备码获取失败时重跑本工具通常即可，不需配代理；用户尚未回复时不要重复调用，以免堆出多个轮询进程。",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["token", "device"], description: "登录方式，默认 device。" },
        token: { type: "string", description: "mode=token 时必填：GitHub Personal Access Token。" },
        hostname: { type: "string", description: "可选主机名，默认 github.com。" },
      },
      required: ["mode"],
    },
    execute: async ({ mode, token, hostname }) => {
      const host = String(hostname || "github.com");
      const command = await resolveGh();
      if (mode === "token") {
        if (!token || String(token).trim().length < 40) {
          return failurePayload("mode=token 需要一个有效的 PAT（至少 40 字符）。或改用 mode=device。", "令牌页：https://github.com/settings/tokens；建议勾选 read:org 与 repo 相关 scope。");
        }
        return await new Promise((resolve) => {
          const child = spawn(command, ["auth", "login", "--hostname", host, "--git-protocol", "https", "--with-token"], {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            env: cleanEnv(),
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("error", (error) => {
            resolve(failurePayload(`登录进程启动失败：${error?.message ?? error}`, error?.code === "ENOENT" ? MISSING_HINT : undefined));
          });
          child.on("close", (code) => {
            if (code === 0) resolve(textPayload("gh auth login 成功（token 已交给 gh 自行保存，本 App 不保留副本）。\n下一步：调用 github_cli_status 验证登录态并向用户确认账号。"));
            else resolve(failurePayload(`gh auth login 失败（退出码 ${code}）：\n${clip([out, err].filter(Boolean).join("\n")) || "无输出，常见原因是令牌无效、已吊销或 scope 不足"}`, "令牌可在 https://github.com/settings/tokens 重新生成；或改用 mode=device 设备码登录。"));
          });
          child.stdin.on("error", () => {});
          child.stdin.end(String(token).trim());
        });
      }
      if (mode !== "device") return failurePayload("mode 只能是 token 或 device。");
      try {
        const flow = await startDeviceFlow({ openBrowser: true });
        return textPayload(
          [
            "✅ 设备码登录流程已启动，后台轮询进程存活中（代码约 15 分钟有效）。",
            "",
            "请把以下三步引导原样转告用户：",
            "  1. 打开授权页 https://github.com/login/device（浏览器通常会自动弹出）",
            `  2. 输入一次性代码：${flow.code}`,
            "  3. 点 Authorize 授权；完成后告诉助手，助手会验证登录态并继续后续任务",
            "",
            "在用户回复前不要重复调用本工具；若授权超时，重跑即可。",
          ].join("\n"),
        );
      } catch (error) {
        return failurePayload(`设备码获取失败：${error?.message ?? error}`, "GitHub 直连偶发瞬时干扰，重跑本工具通常即可；反复失败再考虑手动 gh auth login 或 token 方式。");
      }
    },
  });

  // ==== 工具：退出登录 ====
  await sdk.tools.register({
    name: "github_cli_logout",
    description:
      "退出 GitHub CLI 登录（gh auth logout，仅删本地凭据，不吊销远端令牌）。指定 hostname 时只退该 host，默认退 github.com。用户要求「换个账号」「退出 GitHub」时使用；执行前应向用户确认，因为会影响后续所有 gh 操作。",
    parameters: {
      type: "object",
      properties: {
        hostname: { type: "string", description: "可选主机名，默认 github.com。" },
      },
    },
    execute: async ({ hostname }) => {
      const host = String(hostname || "github.com");
      const before = await readEnvironment();
      if (!before.loggedIn) return textPayload("当前未登录任何 GitHub 账号，无需退出。");
      const res = await runGh(["auth", "logout", "--hostname", host], { timeoutMs: 30_000 });
      if (res.ok) {
        return textPayload(`已退出 ${host} 的 gh 登录（本地凭据已删除，远端令牌未吊销）。\n如需重新登录：github_cli_login(mode=device)。`);
      }
      return failurePayload(`退出失败：\n${[res.stdout, res.stderr, res.status].filter(Boolean).join("\n")}`, "也可在终端执行 gh auth logout --hostname " + host);
    },
  });

  // ==== 面板后端路由（供 ui/panel.html 调用） ====
  await sdk.routes.register((app) => {
    app.get("/status", async (c) => {
      const env = await readEnvironment();
      return c.json({
        ok: true,
        version: VERSION,
        gh: { installed: env.installed, version: env.version },
        auth: { loggedIn: env.loggedIn, account: env.account },
        install: { running: installState.running, done: installState.done, error: installState.error, log: installState.log },
        device:
          deviceFlow?.code && !deviceFlow.closedAt
            ? { active: true, code: deviceFlow.code, url: deviceFlow.url, startedAt: deviceFlow.startedAt }
            : { active: false },
      });
    });

    app.post("/install", async (c) => {
      if (installState.running) return c.json({ ok: true, started: false, message: "安装已在进行中" });
      installState = { running: true, done: false, error: null, log: "", startedAt: Date.now() };
      installGhCli().catch(() => {});
      return c.json({ ok: true, started: true });
    });

    app.post("/login/device", async (c) => {
      if (deviceFlow?.code && !deviceFlow.closedAt) {
        return c.json({ ok: true, reused: true, code: deviceFlow.code, url: deviceFlow.url });
      }
      try {
        const flow = await startDeviceFlow({ openBrowser: true });
        return c.json({ ok: true, code: flow.code, url: flow.url });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    });

    app.post("/logout", async (c) => {
      const res = await runGh(["auth", "logout", "--hostname", "github.com"], { timeoutMs: 30_000 });
      return c.json({ ok: res.ok, output: res.ok ? res.stdout : [res.stdout, res.stderr, res.status].filter(Boolean).join("\n") });
    });

    app.post("/open-device", async (c) => {
      return c.json({ ok: openInBrowser(DEVICE_URL) });
    });
  });

  await sdk.logger.info("github-cli tools registered: status / run / install / login / logout；panel routes mounted");
});
