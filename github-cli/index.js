// GitHub CLI App — 把官方 gh 命令桥接为 Hana 工具，并提供一枚管理面板卡片。
//
// 结构：
//   常量 → 环境与路径 → 进程执行 → 状态读取 → 设备码流程 → 安装管理 → 工具注册 → 面板路由
// 约定：所有子进程都走 cleanEnv()（GitHub 直连，剔除残留代理变量）、无 shell 展开。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- 常量

const VERSION = "0.2.2";
const APP_ID = "github-cli";
const GH_HOST = "github.com";
const DEVICE_URL = "https://github.com/login/device";
const GH_DOWNLOAD_URL = "https://github.com/cli/cli/releases/latest";

const TIMEOUT = {
  probe: 15_000,
  status: 30_000,
  run: 60_000,
  runMax: 180_000,
  install: 15 * 60_000,
  login: 30_000,
  deviceCode: 25_000,
};

const MAX_OUTPUT_CHARS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

const MISSING_HINT =
  "未检测到 GitHub CLI（gh）。可调用 github_cli_install 自动安装，或在终端执行：winget install --id GitHub.cli";

// GitHub 直连原则：Hana 进程树可能残留陈旧 SOCKS/HTTP 代理变量，会把子进程的
// GitHub 请求坑死。起 gh 子进程前统一清除。
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

// ---------------------------------------------------------------- 环境与路径

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
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[输出已截断：共 ${value.length} 字符，保留前 ${MAX_OUTPUT_CHARS} 字符。可用 --jq/--limit 收窄结果。]`;
}

/** Best-effort 调用系统默认浏览器打开 URL；永不抛错。 */
function openInBrowser(url) {
  const commands = {
    win32: ["cmd", ["/c", "start", "", url]],
    darwin: ["open", [url]],
  };
  const [cmd, argv] = commands[process.platform] ?? ["xdg-open", [url]];
  try {
    spawn(cmd, argv, { shell: false, detached: true, stdio: "ignore", env: cleanEnv() }).unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 结果封装

const text = (body) => ({ content: [{ type: "text", text: body }] });

function fail(message, hint) {
  return {
    content: [{ type: "text", text: hint ? `${message}\n提示：${hint}` : message }],
    isError: true,
  };
}

function combine(...parts) {
  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- 进程执行

export const name = APP_ID;

import { defineApp } from "./sdk/app-contract/server-client.js";

export default defineApp(async (sdk) => {
  await sdk.logger.info(`${APP_ID} ${VERSION} loaded`);

  let ghPath = null; // gh 可执行文件路径缓存

  /** 统一的子进程执行器：拒绝 shell 展开，统一超时/缓冲/环境。 */
  async function run(command, argv, { timeoutMs = TIMEOUT.run, cwd } = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(command, argv, {
        shell: false,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: cleanEnv(),
        ...(cwd ? { cwd: String(cwd) } : {}),
      });
      return { ok: true, stdout: clip(stdout), stderr: clip(stderr) };
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: false, enoent: true };
      return {
        ok: false,
        killed: !!error?.killed,
        code: error?.code ?? error?.signal,
        stdout: clip(error?.stdout ?? ""),
        stderr: clip(error?.stderr ?? ""),
        message: error?.message ? String(error.message) : "",
      };
    }
  }

  /** 解析 gh 可执行文件（缓存），找不到时回退到裸命令名由执行错误兜底。 */
  async function resolveGh() {
    if (ghPath) return ghPath;
    const candidates = ghExecutableCandidates();
    try {
      const info = await sdk.process.resolveExecutable({ candidates });
      ghPath = info?.path || candidates.at(-1);
    } catch {
      ghPath = candidates.at(-1);
    }
    return ghPath;
  }

  /** 执行 gh 子命令。 */
  async function gh(argv, options = {}) {
    const result = await run(await resolveGh(), argv, options);
    if (result.enoent) ghPath = null; // 下次重新探测
    return result;
  }

  /** 失败结果转成人类可读的一行摘要。 */
  function describe(result) {
    if (result.killed) return "超时被终止";
    return `退出码 ${result.code ?? "未知"}`;
  }

  // ---------------------------------------------------------------- 状态读取

  /** 一次性读取「是否安装 + 版本 + 登录账号」。 */
  async function readEnvironment() {
    const version = await gh(["--version"], { timeoutMs: TIMEOUT.probe });
    if (!version.ok) return { installed: false, version: null, loggedIn: false, account: null };

    const firstLine = (version.stdout || "").split("\n")[0] || "";
    const auth = await gh(["auth", "status", "--json", "hosts"], { timeoutMs: TIMEOUT.status });

    let hosts = {};
    try {
      hosts = JSON.parse(auth.stdout || "{}").hosts || {};
    } catch {
      hosts = {};
    }
    const accounts = Object.values(hosts)
      .flat()
      .filter((a) => a && a.state === "success");
    const account = accounts.find((a) => a.active) || accounts[0] || null;

    return {
      installed: true,
      version: firstLine.replace(/^gh version\s*/i, "").trim() || firstLine,
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

  // ---------------------------------------------------------------- 设备码登录流程

  // 关键：拿到码后进程必须存活并持续轮询，否则接不住用户的授权动作。
  let deviceFlow = null; // { code, url, startedAt, closedAt }

  async function startDeviceFlow({ openBrowser = false } = {}) {
    const existing = activeDeviceFlow();
    if (existing) {
      if (openBrowser) openInBrowser(DEVICE_URL);
      return existing;
    }

    const flow = { code: null, url: DEVICE_URL, startedAt: Date.now(), closedAt: null };
    const child = spawn(
      await resolveGh(),
      ["auth", "login", "--hostname", GH_HOST, "--git-protocol", "https", "--web"],
      { shell: false, stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() },
    );

    let buffer = "";
    child.stdout.on("data", (d) => (buffer += d));
    child.stderr.on("data", (d) => (buffer += d));
    // 只关闭本次流程对象，避免旧流程的回调误标新流程
    child.on("close", () => {
      ghPath = null;
      flow.closedAt = Date.now();
    });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("25 秒内未拿到设备码：对 github.com 的请求被瞬时干扰，重试即可（GitHub 直连，无需代理）")),
        TIMEOUT.deviceCode,
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
        reject(
          new Error(
            netFail
              ? `网络层失败（直连 github.com 瞬时不稳定）：${clip(buffer) || "无输出"}`
              : `gh 提前退出：${clip(buffer) || "无输出"}`,
          ),
        );
      });
    }).catch((error) => ({ error: String(error?.message ?? error) }));

    if (typeof code === "object") {
      child.kill();
      throw new Error(code.error);
    }

    // 关键：拿到码后进程必须存活并持续轮询，否则接不住用户的授权动作。
    child.unref();
    flow.code = code;
    deviceFlow = flow;
    if (openBrowser) openInBrowser(DEVICE_URL);
    return flow;
  }

  function activeDeviceFlow() {
    return deviceFlow?.code && !deviceFlow.closedAt ? deviceFlow : null;
  }

  /** token 登录：把 PAT 经 stdin 交给 gh（不落盘、不回显）。 */
  async function loginWithToken(host, token) {
    const command = await resolveGh();
    return new Promise((resolve) => {
      const child = spawn(
        command,
        ["auth", "login", "--hostname", host, "--git-protocol", "https", "--with-token"],
        { shell: false, stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (error) =>
        resolve(fail(`登录进程启动失败：${error?.message ?? error}`, error?.code === "ENOENT" ? MISSING_HINT : undefined)),
      );
      child.on("close", (code) => {
        if (code === 0) {
          ghPath = null;
          resolve(text("gh auth login 成功（token 已交给 gh 自行保存，本 App 不保留副本）。\n下一步：调用 github_cli_status 验证登录态并向用户确认账号。"));
        } else {
          resolve(
            fail(
              `gh auth login 失败（退出码 ${code}）：\n${clip(combine(out, err)) || "无输出，常见原因是令牌无效、已吊销或 scope 不足"}`,
              "令牌可在 https://github.com/settings/tokens 重新生成；或改用 mode=device 设备码登录。",
            ),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(String(token).trim());
    });
  }

  // ---------------------------------------------------------------- 安装管理

  let installState = { running: false, done: false, error: null, log: "", startedAt: null };
  let installPromise = null;

  function installArgv() {
    if (process.platform === "win32") {
      return {
        command: "winget",
        argv: ["install", "--id", "GitHub.cli", "--accept-source-agreements", "--accept-package-agreements", "--silent"],
      };
    }
    if (process.platform === "darwin") return { command: "brew", argv: ["install", "gh"] };
    return null;
  }

  /** 幂等启动安装：并发调用共享同一个 Promise，完成后可再次启动（重装）。 */
  function startInstall() {
    if (installPromise) return installPromise;

    const startedAt = Date.now();
    installState = { running: true, done: false, error: null, log: "", startedAt };

    installPromise = (async () => {
      const target = installArgv();
      if (!target) {
        installState = {
          running: false,
          done: true,
          error: `当前平台（${process.platform}）不支持自动安装，请手动安装 gh`,
          log: "",
          startedAt,
        };
        return installState;
      }

      const result = await run(target.command, target.argv, { timeoutMs: TIMEOUT.install });
      ghPath = null; // 装完重新探测

      if (result.enoent) {
        installState = {
          running: false,
          done: true,
          error: `未找到包管理器 ${target.command}，请手动安装`,
          log: "可手动执行：winget install --id GitHub.cli",
          startedAt,
        };
        return installState;
      }

      const log = clip(combine(result.stdout, result.stderr)) || "（无输出）";
      const probe = await gh(["--version"], { timeoutMs: TIMEOUT.probe });
      const ok = probe.ok || /successfully installed|已成功安装/i.test(log);

      installState = {
        running: false,
        done: true,
        error: ok ? null : result.message || "安装命令结束但未检测到 gh，请查看日志",
        log,
        startedAt,
      };
      return installState;
    })().finally(() => {
      installPromise = null;
    });

    return installPromise;
  }

  // ---------------------------------------------------------------- 工具注册

  await sdk.tools.register({
    name: "github_cli_status",
    description:
      "查看本机 GitHub CLI 与登录状态：返回 gh 版本、登录账号、scope、协议。用于确认环境是否就绪，或诊断「连不上 GitHub」。无需参数。若未安装 gh，会提示可用 github_cli_install 一键安装。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const env = await readEnvironment();
      const lines = [`GitHub CLI App v${VERSION}`];
      if (!env.installed) {
        lines.push("gh：未安装", `下一步：${MISSING_HINT}`);
        return text(lines.join("\n"));
      }
      lines.push(`gh：${env.version || "（版本未知）"}`);
      if (env.loggedIn && env.account) {
        lines.push(
          `登录：✓ ${env.account.login} @ ${env.account.host}`,
          `scope：${env.account.scopes || "（未报告）"}`,
          `协议：${env.account.protocol || "https"}｜凭据：${env.account.tokenSource || "未知"}`,
        );
        if (activeDeviceFlow()) lines.push("（面板里还有一个待完成的设备码授权流程）");
      } else {
        lines.push("登录：未登录", "下一步：调用 github_cli_login（mode=device 推荐）登录，或在应用管理面板点「登录」。");
      }
      return text(lines.join("\n"));
    },
  });

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
        timeoutMs: { type: "number", description: `可选超时（毫秒），默认 ${TIMEOUT.run}，上限 ${TIMEOUT.runMax}。` },
      },
      required: ["args"],
    },
    execute: async ({ args, cwd, timeoutMs }) => {
      if (!Array.isArray(args) || args.length === 0) return fail("args 必须是非空字符串数组。");

      const argv = args.map(String);
      if (argv[0]?.toLowerCase() === "gh") argv.shift();
      if (argv.some((a) => /[<>|;&$`]/.test(a))) {
        return fail("参数含 shell 元字符，已拒绝。gh 子命令本身支持所需能力（如 --json/--jq/--web），无需管道。");
      }

      const timeout = Math.min(Math.max(Number(timeoutMs) || TIMEOUT.run, 5_000), TIMEOUT.runMax);
      const result = await gh(argv, { timeoutMs: timeout, cwd });

      if (result.enoent) return fail(MISSING_HINT);
      const label = `gh ${argv.join(" ")}`;
      if (result.ok) {
        return text(`${label} 执行成功：\n\n${combine(result.stdout, result.stderr && `[stderr]\n${result.stderr}`) || "（无输出）"}`);
      }
      return fail(
        `${label} 失败（${describe(result)}）。\n${combine(result.stdout, result.stderr) || result.message}`,
        "gh 非零退出常因未登录、无权限或不在 git 仓库内；可先跑 github_cli_status 或补 cwd。",
      );
    },
  });

  await sdk.tools.register({
    name: "github_cli_install",
    description:
      "在本机安装 GitHub CLI（gh）。Windows 走 winget install --id GitHub.cli，macOS 走 brew install gh。安装可能耗时数分钟并弹出系统权限确认。装好后本应用会自动重新探测 gh。用于用户在 github_cli_status 里看到「gh 未安装」时。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const before = await readEnvironment();
      if (before.installed) {
        return text(`gh 已安装（${before.version}），无需重复安装。下载页：${GH_DOWNLOAD_URL}`);
      }

      const state = await startInstall();
      if (state.error) {
        return fail(state.error, `可手动安装：winget install --id GitHub.cli；或从 ${GH_DOWNLOAD_URL} 下载。\n日志：${state.log}`);
      }

      const after = await readEnvironment();
      if (after.installed) {
        return text(`GitHub CLI 安装成功：${after.version}\n下一步：调用 github_cli_login(mode=device) 登录，或在应用管理面板点「登录」。`);
      }
      return fail("安装命令已执行，但仍未探测到 gh。可能需要重开终端或重启 Hana 让 PATH 生效。", `日志：${state.log}`);
    },
  });

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
      const host = String(hostname || GH_HOST);

      if (mode === "token") {
        if (!token || String(token).trim().length < 40) {
          return fail(
            "mode=token 需要一个有效的 PAT（至少 40 字符）。或改用 mode=device。",
            "令牌页：https://github.com/settings/tokens；建议勾选 read:org 与 repo 相关 scope。",
          );
        }
        return loginWithToken(host, token);
      }

      if (mode !== "device") return fail("mode 只能是 token 或 device。");

      try {
        const flow = await startDeviceFlow({ openBrowser: true });
        return text(
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
        return fail(
          `设备码获取失败：${error?.message ?? error}`,
          "GitHub 直连偶发瞬时干扰，重跑本工具通常即可；反复失败再考虑手动 gh auth login 或 token 方式。",
        );
      }
    },
  });

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
      const host = String(hostname || GH_HOST);
      const before = await readEnvironment();
      if (!before.loggedIn) return text("当前未登录任何 GitHub 账号，无需退出。");

      const result = await gh(["auth", "logout", "--hostname", host], { timeoutMs: TIMEOUT.login });
      if (result.ok) {
        deviceFlow = null;
        return text(`已退出 ${host} 的 gh 登录（本地凭据已删除，远端令牌未吊销）。\n如需重新登录：github_cli_login(mode=device)。`);
      }
      return fail(
        `退出失败：\n${combine(result.stdout, result.stderr, result.ok ? "" : describe(result))}`,
        `也可在终端执行 gh auth logout --hostname ${host}`,
      );
    },
  });

  // ---------------------------------------------------------------- 面板后端路由

  await sdk.routes.register((app) => {
    app.get("/status", async (c) => {
      const env = await readEnvironment();
      const flow = activeDeviceFlow();
      return c.json({
        ok: true,
        version: VERSION,
        gh: { installed: env.installed, version: env.version },
        auth: { loggedIn: env.loggedIn, account: env.account },
        install: { running: installState.running, done: installState.done, error: installState.error, log: installState.log },
        device: flow ? { active: true, code: flow.code, url: flow.url, startedAt: flow.startedAt } : { active: false },
      });
    });

    app.post("/install", (c) => {
      const started = !installPromise;
      startInstall().catch(() => {});
      return c.json({ ok: true, started, message: started ? undefined : "安装已在进行中" });
    });

    app.post("/login/device", async (c) => {
      const existing = activeDeviceFlow();
      if (existing) return c.json({ ok: true, reused: true, code: existing.code, url: existing.url });
      try {
        const flow = await startDeviceFlow({ openBrowser: true });
        return c.json({ ok: true, code: flow.code, url: flow.url });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    });

    app.post("/logout", async (c) => {
      const result = await gh(["auth", "logout", "--hostname", GH_HOST], { timeoutMs: TIMEOUT.login });
      if (result.ok) deviceFlow = null;
      return c.json({ ok: result.ok, output: result.ok ? result.stdout : combine(result.stdout, result.stderr, describe(result)) });
    });

    app.post("/open-device", (c) => c.json({ ok: openInBrowser(DEVICE_URL) }));
  });

  await sdk.logger.info(
    `${APP_ID} ready: tools=status/run/install/login/logout, routes=status/install/login/logout/open-device`,
  );
});
