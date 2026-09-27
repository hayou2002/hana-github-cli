// GitHub CLI App — 把官方 gh 命令桥接为 Hana 工具 + 一枚管理面板卡片。
//
// 分层：
//   lib/gh-core.js  纯逻辑与平台适配（可单测，不依赖宿主）
//   index.js        与宿主 SDK 打交道：工具注册、面板路由、子进程编排
// 约束：子进程一律 cleanEnv()（GitHub 直连，剔除残留代理变量）、无 shell 展开。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  GH_HOST,
  GH_REPO,
  DEVICE_URL,
  GH_DOWNLOAD_URL,
  GH_MIRRORS,
  UNINSTALL_QUERY,
  cleanEnv,
  ghExecutableCandidates,
  clip,
  parseGhVersion,
  compareVersions,
  parseAuthStatus,
  extractDeviceCode,
  looksLikeNetworkFailure,
  msiUrl,
  mirrorLabel,
  rankMirrorResults,
  buildElevateCommand,
  parseProductCode,
} from "./lib/gh-core.js";

const execFileAsync = promisify(execFile);

const VERSION = "0.2.8";

const TIMEOUT = {
  probe: 15_000,
  status: 30_000,
  run: 60_000,
  runMax: 180_000,
  meta: 12_000,
  speed: 8_000,
  download: 10 * 60_000,
  install: 10 * 60_000,
  login: 30_000,
  deviceCode: 25_000,
};

const MAX_BUFFER = 16 * 1024 * 1024;
const LOG_KEEP = 8000;

const MISSING_HINT =
  "未检测到 GitHub CLI（gh）。可调用 github_cli_install 自动安装，或在终端执行：winget install --id GitHub.cli";

const text = (body) => ({ content: [{ type: "text", text: body }] });
const fail = (message, hint) => ({
  content: [{ type: "text", text: hint ? `${message}\n提示：${hint}` : message }],
  isError: true,
});
const combine = (...parts) => parts.filter(Boolean).join("\n");

/** Best-effort：用系统默认浏览器打开 URL；永不抛错。 */
function openInBrowser(url) {
  const [cmd, argv] =
    { win32: ["cmd", ["/c", "start", "", url]], darwin: ["open", [url]] }[process.platform] ?? ["xdg-open", [url]];
  try {
    spawn(cmd, argv, { shell: false, detached: true, stdio: "ignore", env: cleanEnv() }).unref();
    return true;
  } catch {
    return false;
  }
}

export const name = "github-cli";

import { defineApp } from "./sdk/app-contract/server-client.js";

export default defineApp(async (sdk) => {
  await sdk.logger.info(`github-cli ${VERSION} loaded`);

  const isWindows = process.platform === "win32";
  // 下载临时目录必须落在宿主授权的可写根内（ctx.dataDir）。
  // 宿主以 Node 权限模型启动 App 进程：`--allow-fs-write=<dataDir>`，
  // 写 os.tmpdir() 会被拒（Access to this API has been restricted）。
  const workDir = path.join(sdk.dataDir || os.tmpdir(), "downloads");

  // ---------------------------------------------------------------- 进程执行

  /** 清掉下载目录里的旧安装包（dataDir 不随卸载清空，避免堆积）。best-effort，永不抛错。
   *  注意：宿主沙箱下 `fs.rmSync` 会静默失效（不报错但不删除），必须用 `unlinkSync`。 */
  function cleanupWorkDir() {
    try {
      if (!fs.existsSync(workDir)) return;
      for (const f of fs.readdirSync(workDir)) {
        if (/\.msi$/i.test(f)) fs.unlinkSync(path.join(workDir, f));
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

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

  /** 解析 gh 可执行路径。结果缓存；并发调用共享同一次解析。 */
  let ghPath = null; // 已解析成功的路径
  let ghPathPending = null; // 进行中的解析（并行调用复用它，避免重复解析）
  async function resolveGh() {
    if (ghPath) return ghPath;
    if (ghPathPending) return ghPathPending;
    ghPathPending = (async () => {
      const candidates = ghExecutableCandidates(process.env, process.platform);
      try {
        const info = await sdk.process.resolveExecutable({ candidates });
        return info?.path || candidates.at(-1);
      } catch {
        return candidates.at(-1);
      }
    })()
      .then((resolved) => {
        ghPath = resolved;
        return resolved;
      })
      .finally(() => {
        ghPathPending = null;
      });
    return ghPathPending;
  }

  async function gh(argv, options = {}) {
    const result = await run(await resolveGh(), argv, options);
    if (result.enoent) ghPath = null;
    return result;
  }

  const describe = (r) => (r.killed ? "超时被终止" : `退出码 ${r.code ?? "未知"}`);

  // ---------------------------------------------------------------- 状态

  async function readEnvironment() {
    // 两次探测相互独立，并行发出（每次 gh 调用都是一次进程启动，串行会白白多等一倍）
    const [version, auth] = await Promise.all([
      gh(["--version"], { timeoutMs: TIMEOUT.probe }),
      gh(["auth", "status", "--json", "hosts"], { timeoutMs: TIMEOUT.status }),
    ]);
    if (!version.ok) return { installed: false, version: null, loggedIn: false, account: null };

    const parsed = parseGhVersion(version.stdout) || (version.stdout || "").split("\n")[0].trim();
    const { loggedIn, account } = parseAuthStatus(auth.stdout);
    return { installed: true, version: parsed, loggedIn, account };
  }

  // ---------------------------------------------------------------- 设备码登录

  // 拿到码后进程必须存活并持续轮询，否则接不住用户的授权动作。
  let deviceFlow = null; // { code, url, startedAt, closedAt }
  const activeDeviceFlow = () => (deviceFlow?.code && !deviceFlow.closedAt ? deviceFlow : null);

  async function startDeviceFlow() {
    const existing = activeDeviceFlow();
    if (existing) return existing;

    const flow = { code: null, url: DEVICE_URL, startedAt: Date.now(), closedAt: null };
    const child = spawn(
      await resolveGh(),
      ["auth", "login", "--hostname", GH_HOST, "--git-protocol", "https", "--web"],
      { shell: false, stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() },
    );

    let buffer = "";
    child.stdout.on("data", (d) => (buffer += d));
    child.stderr.on("data", (d) => (buffer += d));
    child.on("close", () => {
      ghPath = null;
      flow.closedAt = Date.now();
    });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("25 秒内未拿到设备码：对 github.com 的请求被瞬时干扰，重试即可")),
        TIMEOUT.deviceCode,
      );
      const onData = () => {
        const found = extractDeviceCode(buffer);
        if (found) {
          clearTimeout(timer);
          resolve(found);
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
        reject(
          new Error(
            looksLikeNetworkFailure(buffer)
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

    child.unref();
    flow.code = code;
    deviceFlow = flow;
    return flow;
  }

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
          resolve(text("gh auth login 成功（token 已交给 gh 自行保存，本 App 不保留副本）。\n下一步：github_cli_status 验证登录态。"));
        } else {
          resolve(
            fail(
              `gh auth login 失败（退出码 ${code}）：\n${clip(combine(out, err)) || "无输出，常见原因是令牌无效、已吊销或 scope 不足"}`,
              "令牌可在 https://github.com/settings/tokens 重新生成；或改用 mode=device。",
            ),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(String(token).trim());
    });
  }

  // ---------------------------------------------------------------- 任务状态

  /** 任务状态的唯一形状。三处（初始 / 启动 / 重置）共用同一工厂，避免字段漂移。 */
  function makeJob(patch = {}) {
    return { running: false, action: null, phase: null, percent: null, source: null, log: "", error: null, done: false, ...patch };
  }

  let job = makeJob();
  let jobPromise = null;

  const pushLog = (line) => {
    const clean = String(line).replace(/\r/g, "").trimEnd();
    if (clean) job.log = `${job.log ? `${job.log}\n` : ""}${clean}`.slice(-LOG_KEEP);
  };

  /** 拉取最新版本号（失败返回 null，不阻塞流程）。 */
  async function latestGhVersion() {
    const r = await run(
      "curl.exe",
      ["-sL", "--max-time", "10", "-H", "Accept: application/vnd.github+json", `https://api.github.com/repos/${GH_REPO}/releases/latest`],
      { timeoutMs: TIMEOUT.meta },
    );
    if (!r.ok) return null;
    return parseGhVersion(JSON.parse(r.stdout || "{}")?.tag_name ?? "");
  }

  /** 并行测速所有镜像，返回降序结果。 */
  async function rankSources(version) {
    const probes = GH_MIRRORS.map(async (base) => {
      const r = await run(
        "curl.exe",
        ["-sL", "-o", "NUL", "-w", "%{speed_download}", "--max-time", String(Math.round(TIMEOUT.speed / 1000)), "-r", "0-1200000", msiUrl(version, base)],
        { timeoutMs: TIMEOUT.speed + 2000 },
      );
      return { base, speed: Number.parseFloat(r.stdout) || 0 };
    });
    return rankMirrorResults(await Promise.all(probes));
  }

  /** 带进度回调下载；返回 ok/error。 */
  function curlDownload(url, dest, { timeoutMs = TIMEOUT.download } = {}) {
    return new Promise((resolve) => {
      const child = spawn(
        "curl.exe",
        ["-L", "-#", "-o", dest, "--max-time", String(Math.round(timeoutMs / 1000)), url],
        { shell: false, stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() },
      );
      let tail = "";
      const onChunk = (buf) => {
        const s = String(buf);
        const m = s.match(/(\d+(?:\.\d+)?)%/g);
        if (m) job.percent = Number.parseFloat(m.at(-1));
        tail = (tail + s).slice(-300);
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: String(error?.message ?? error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true } : { ok: false, error: `curl 退出码 ${code}${tail ? `：${tail.trim().slice(-160)}` : ""}` });
      });
    });
  }

  /** Windows：以管理员身份运行（UAC）。msiexec 装/卸必须提权。 */
  async function runElevated(exe, args) {
    if (!isWindows) return { ok: false, error: "非 Windows 平台不支持提权调用" };
    const cmd = buildElevateCommand(exe, args);
    const r = await run("powershell.exe", ["-NoProfile", "-Command", cmd], { timeoutMs: TIMEOUT.install });
    if (!r.ok) {
      const blob = combine(r.stderr, r.stdout, r.message);
      if (/canceled by the user|用户已取消|操作已被用户取消/i.test(blob)) {
        return { ok: false, canceled: true, error: "用户取消了权限确认（UAC）" };
      }
      return { ok: false, error: `提权执行失败：${blob || describe(r)}` };
    }
    return { ok: true };
  }

  /** 兜底：交给 winget（它自带源与提权处理）。 */
  async function wingetJob(action) {
    const argv =
      action === "uninstall"
        ? ["uninstall", "--id", "GitHub.cli", "--silent", "--accept-source-agreements"]
        : action === "upgrade"
          ? ["upgrade", "--id", "GitHub.cli", "--silent", "--accept-source-agreements", "--accept-package-agreements"]
          : ["install", "--id", "GitHub.cli", "--silent", "--accept-source-agreements", "--accept-package-agreements"];
    job.phase = action === "uninstall" ? "卸载中（winget）" : `${action === "upgrade" ? "升级" : "安装"}中（winget）`;
    pushLog(`$ winget ${argv.join(" ")}`);
    const r = await run("winget", argv, { timeoutMs: TIMEOUT.install });
    if (r.enoent) return { error: "未找到 winget，请手动执行：winget install --id GitHub.cli" };
    for (const line of combine(r.stdout, r.stderr).split("\n").slice(-10)) pushLog(line);
    ghPath = null;
    if (action === "uninstall") return r.ok ? { ok: true } : { error: `卸载失败（${describe(r)}）` };
    const probe = await gh(["--version"], { timeoutMs: TIMEOUT.probe });
    return probe.ok
      ? { ok: true, version: parseGhVersion(probe.stdout) }
      : { error: r.ok ? "命令完成但未检测到 gh" : `失败（${describe(r)}）` };
  }

  /** 安装 / 升级：版本短路 → 测速 → 下载 → 提权安装 → 失败回退 winget。 */
  async function installJob(action) {
    job.phase = "检查版本";
    const current = (await readEnvironment()).version;
    pushLog(`当前版本：${current || "未安装"}`);

    const latest = await latestGhVersion();
    if (latest) {
      pushLog(`最新版本：${latest}`);
      if (action === "upgrade" && current && compareVersions(current, latest) >= 0) {
        job.phase = `已是最新版本（${current}）`;
        return { ok: true, upToDate: true, version: current };
      }
    } else {
      pushLog("获取最新版本号失败，改走 winget");
      return wingetJob(action);
    }

    fs.mkdirSync(workDir, { recursive: true });
    cleanupWorkDir(); // dataDir 不随卸载清空，先清掉上次残留的 MSI
    const msiPath = path.join(workDir, `gh_${latest}.msi`);

    job.phase = "测速选源";
    const ranked = await rankSources(latest);
    if (ranked.length === 0) {
      pushLog("所有下载源均不可用，改走 winget");
      return wingetJob(action);
    }
    for (const r of ranked) pushLog(`${mirrorLabel(r.base)}：${(r.speed / 1024).toFixed(0)} KB/s`);

    // 依次尝试：最快源 → 其余源 → winget
    for (const [i, candidate] of ranked.entries()) {
      const label = mirrorLabel(candidate.base);
      job.source = label;
      job.phase = `下载安装包（${label}）`;
      job.percent = 0;
      const dl = await curlDownload(msiUrl(latest, candidate.base), msiPath);
      if (!dl.ok) {
        pushLog(`${label} 下载失败：${dl.error}`);
        continue;
      }
      pushLog(`${label} 下载完成`);

      job.phase = "安装中（可能弹出管理员权限确认）";
      job.percent = null;
      const res = await runElevated("msiexec.exe", ["/i", msiPath, "/qb", "/norestart"]);
      if (res.canceled) return { error: res.error };
      if (!res.ok) {
        pushLog(`静默安装失败：${res.error}`);
        continue;
      }

      job.phase = "验证";
      ghPath = null;
      const probe = await gh(["--version"], { timeoutMs: TIMEOUT.probe });
      if (probe.ok) {
        pushLog(probe.stdout.split("\n")[0] || "");
        return { ok: true, version: parseGhVersion(probe.stdout) };
      }
      pushLog("安装程序结束但未检测到 gh");
      break;
    }

    pushLog("自定义安装未成功，改走 winget");
    return wingetJob(action);
  }

  /** 卸载：优先 winget，失败再按产品码提权 msiexec 卸载。 */
  async function uninstallJob() {
    job.phase = "卸载中（winget）";
    const w = await wingetJob("uninstall");
    if (w.ok) return w;
    pushLog(`winget 卸载未成功：${w.error}`);
    pushLog("尝试按产品码卸载");

    const q = await run("powershell.exe", UNINSTALL_QUERY, { timeoutMs: TIMEOUT.meta });
    const productCode = parseProductCode(q.stdout);
    if (!productCode) return { error: "未找到 GitHub CLI 的安装信息，可能已卸载或为其它安装方式" };

    job.phase = "卸载中（可能弹出管理员权限确认）";
    const res = await runElevated("msiexec.exe", ["/x", productCode, "/qb", "/norestart"]);
    if (res.canceled) return { error: res.error };
    if (!res.ok) return { error: res.error };

    ghPath = null;
    const probe = await gh(["--version"], { timeoutMs: TIMEOUT.probe });
    return probe.ok ? { error: "卸载命令已执行但仍检测到 gh" } : { ok: true };
  }

  /** 幂等启动任务；并发调用共享同一个 Promise。 */
  function startJob(action) {
    if (jobPromise) return jobPromise;
    job = makeJob({ running: true, action, phase: "准备中" });

    jobPromise = (async () => {
      try {
        const r = action === "uninstall" ? await uninstallJob() : await installJob(action);
        if (r.error) job.error = r.error;
        else if (r.upToDate) job.done = true;
        else job.phase = action === "uninstall" ? "已卸载" : action === "upgrade" ? "升级完成" : "安装完成";
      } catch (error) {
        job.error = String(error?.message ?? error);
      } finally {
        job.running = false;
        job.done = true;
        job.percent = null;
      }
      return job;
    })().finally(() => {
      jobPromise = null;
    });

    return jobPromise;
  }

  // ---------------------------------------------------------------- 工具

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
      "执行一条 gh 命令（参数以数组传递，不经过 shell，无通配/管道展开）。读操作可直接跑，例如 [\"repo\",\"list\",\"--limit\",\"20\"]、[\"pr\",\"list\",\"--repo\",\"owner/name\"]、[\"api\",\"repos/owner/name\"]。写操作（create/edit/merge/close/delete/push/release 等）请先向用户展示完整参数并获确认后再调用。可用 cwd 指定仓库目录。",
    parameters: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "gh 之后的参数数组，不含 gh 本身，不含 shell 元字符。", minItems: 1 },
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
      "安装 / 升级 / 卸载 GitHub CLI（gh）。会自动测速挑选最快下载源下载官方 MSI 并静默安装（失败回退 winget）；升级时若已是最新版本会直接反馈、不做多余动作。mode：install（安装，已装则重装）、upgrade（升级）、uninstall（卸载）。可能耗时数分钟并弹出系统权限确认（UAC）。",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["install", "upgrade", "uninstall"], description: "默认 install。" } },
    },
    execute: async ({ mode }) => {
      const action = ["install", "upgrade", "uninstall"].includes(mode) ? mode : "install";

      if (action !== "uninstall") {
        const before = await readEnvironment();
        if (before.installed && action === "install") {
          return text(`gh 已安装（${before.version}）。要更新用 mode=upgrade；要卸载用 mode=uninstall。`);
        }
        if (!before.installed && action === "upgrade") {
          return text(`gh 尚未安装，已按安装处理。\n下载页：${GH_DOWNLOAD_URL}`);
        }
      }

      const state = await startJob(action);
      const detail = state.log ? `\n日志：\n${state.log}` : "";
      if (state.error) {
        return fail(`${action} 失败：${state.error}`, `可手动执行：winget install --id GitHub.cli；或从 ${GH_DOWNLOAD_URL} 下载。${detail}`);
      }
      if (action === "uninstall") return text(`GitHub CLI 已卸载。${detail}`);
      const after = await readEnvironment();
      return text(`${action === "upgrade" ? "升级" : "安装"}完成：gh ${after.version || state.version || ""}\n下一步：github_cli_login(mode=device) 登录。${detail}`);
    },
  });

  await sdk.tools.register({
    name: "github_cli_login",
    description:
      "登录 GitHub CLI（带阶段引导）。两种方式：1) mode=token：用户手边有 PAT 时用，经 stdin 直交 gh auth login --with-token，App 不落盘不回显。2) mode=device（默认推荐）：设备码流程，本工具启动后台轮询进程并拿到一次性代码，返回值含代码、授权页链接和三步用户引导，请原样转告用户；后台进程保持存活到授权完成或代码过期（约 15 分钟）。完成后应主动调用 github_cli_status 验证。GitHub 直连偶发瞬时干扰，失败重跑即可、不需配代理；用户尚未回复时不要重复调用。",
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
          return fail("mode=token 需要一个有效的 PAT（至少 40 字符）。或改用 mode=device。", "令牌页：https://github.com/settings/tokens；建议勾选 read:org 与 repo 相关 scope。");
        }
        return loginWithToken(host, token);
      }
      if (mode !== "device") return fail("mode 只能是 token 或 device。");

      try {
        const flow = await startDeviceFlow();
        openInBrowser(DEVICE_URL); // 后端开系统默认浏览器（面板 iframe 内不可靠）
        return text(
          [
            "✅ 设备码登录流程已启动，后台轮询进程存活中（代码约 15 分钟有效）。",
            "",
            "请把以下三步引导原样转告用户：",
            "  1. 打开授权页 https://github.com/login/device（系统默认浏览器已自动打开）",
            `  2. 输入一次性代码：${flow.code}`,
            "  3. 点 Authorize 授权；完成后告诉助手，助手会验证登录态",
            "",
            "在用户回复前不要重复调用本工具；若授权超时，重跑即可。",
          ].join("\n"),
        );
      } catch (error) {
        return fail(`设备码获取失败：${error?.message ?? error}`, "GitHub 直连偶发瞬时干扰，重跑本工具通常即可。");
      }
    },
  });

  await sdk.tools.register({
    name: "github_cli_logout",
    description:
      "退出 GitHub CLI 登录（gh auth logout，仅删本地凭据，不吊销远端令牌）。默认退 github.com。用户要求「换账号」「退出 GitHub」时用；执行前应向用户确认。",
    parameters: { type: "object", properties: { hostname: { type: "string", description: "可选主机名，默认 github.com。" } } },
    execute: async ({ hostname }) => {
      const host = String(hostname || GH_HOST);
      const before = await readEnvironment();
      if (!before.loggedIn) return text("当前未登录任何 GitHub 账号，无需退出。");

      const result = await gh(["auth", "logout", "--hostname", host], { timeoutMs: TIMEOUT.login });
      if (result.ok) {
        deviceFlow = null;
        return text(`已退出 ${host} 的 gh 登录（本地凭据已删除，远端令牌未吊销）。\n如需重新登录：github_cli_login(mode=device)。`);
      }
      return fail(`退出失败：\n${combine(result.stdout, result.stderr, describe(result))}`, `也可在终端执行 gh auth logout --hostname ${host}`);
    },
  });

  // ---------------------------------------------------------------- 面板路由

  const jobSnapshot = () => ({
    running: job.running,
    action: job.action,
    phase: job.phase,
    percent: job.percent,
    source: job.source,
    log: job.log,
    error: job.error,
    done: job.done,
  });

  await sdk.routes.register((app) => {
    app.get("/status", async (c) => {
      const env = await readEnvironment();
      const flow = activeDeviceFlow();
      return c.json({
        ok: true,
        version: VERSION,
        gh: { installed: env.installed, version: env.version },
        auth: { loggedIn: env.loggedIn, account: env.account },
        job: jobSnapshot(),
        device: flow ? { active: true, code: flow.code, url: flow.url, startedAt: flow.startedAt } : { active: false },
      });
    });

    app.post("/job", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const action = ["install", "upgrade", "uninstall"].includes(body?.action) ? body.action : "install";
      const started = !jobPromise;
      startJob(action).catch(() => {});
      return c.json({ ok: true, started, action, message: started ? undefined : "已有任务在进行中" });
    });

    // 清除已完成任务的日志/进度残留（任务进行中时不生效）
    app.post("/clear-log", (c) => {
      if (!job.running) job = makeJob();
      return c.json({ ok: true });
    });

    app.post("/login/device", async (c) => {
      const existing = activeDeviceFlow();
      if (existing) {
        openInBrowser(DEVICE_URL); // 复用已有流程时也确保浏览器打开
        return c.json({ ok: true, reused: true, code: existing.code, url: existing.url, browserOpened: true });
      }
      try {
        const flow = await startDeviceFlow();
        // 浏览器由后端打开：面板 iframe 里 hana.external.open 不可靠，cmd/start 已验证可用
        const browserOpened = openInBrowser(DEVICE_URL);
        return c.json({ ok: true, code: flow.code, url: flow.url, browserOpened });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    });

    app.post("/open-device", (c) => c.json({ ok: openInBrowser(DEVICE_URL) }));

    app.post("/logout", async (c) => {
      const result = await gh(["auth", "logout", "--hostname", GH_HOST], { timeoutMs: TIMEOUT.login });
      if (result.ok) deviceFlow = null;
      return c.json({ ok: result.ok, output: result.ok ? result.stdout : combine(result.stdout, result.stderr, describe(result)) });
    });
  });

  await sdk.logger.info(`${"github-cli"} ${VERSION} ready: tools=status/run/install/login/logout, routes=status/job/clear-log/login/logout/open-device`);
});
