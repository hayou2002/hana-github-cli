// GitHub CLI App — 把官方 gh 命令桥接为 Hana 工具。
// 设计对齐 jimeng-cli：清单声明 app/process.spawn，实体命令走 execFile（无 shell 展开）。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const VERSION = "0.1.1";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 60_000;

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

export const name = "github-cli";

import { defineApp } from "./sdk/app-contract/server-client.js";

export default defineApp(async (sdk) => {
  await sdk.logger.info(`github-cli ${VERSION} loaded`);

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
        env: process.env,
      });
      return { ok: true, stdout: clip(stdout), stderr: clip(stderr) };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ok: false, missing: true };
      }
      const stdout = clip(error?.stdout ?? "");
      const stderr = clip(error?.stderr ?? "");
      const status = error?.killed ? "命令超时被终止" : `gh 退出码 ${error?.code ?? error?.signal ?? "未知"}`;
      return { ok: false, failed: true, status, stdout, stderr, message: String(error?.message ?? error) };
    }
  }

  const MISSING_HINT = "未检测到 GitHub CLI（gh）。安装：winget install --id GitHub.cli";

  await sdk.tools.register({
    name: "github_cli_status",
    description:
      "查看本机 GitHub CLI 与登录状态：返回 gh 版本、gh auth status 的账号/协议/令牌类型摘要。用于确认环境是否就绪，或诊断「连不上 GitHub」。无需参数。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const version = await runGh(["--version"], { timeoutMs: 15_000 });
      if (version.missing) return failurePayload(MISSING_HINT);
      const auth = await runGh(["auth", "status"], { timeoutMs: 30_000 });
      const lines = [];
      lines.push(`GitHub CLI App v${VERSION}`);
      lines.push(`gh：${(version.stdout || "").split("\n")[0] || "（版本输出为空）"}`);
      if (auth.ok) {
        const combined = [auth.stdout, auth.stderr].filter(Boolean).join("\n");
        lines.push("auth status：", clip(combined));
      } else if (auth.failed) {
        const combined = [auth.stdout, auth.stderr, auth.status].filter(Boolean).join("\n");
        lines.push("auth status（未登录或令牌失效）：", clip(combined));
        lines.push("下一步：用 github_cli_login 登录（token 或 device 两种方式）。");
      }
      return textPayload(lines.join("\n"));
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
        timeoutMs: { type: "number", description: `可选超时（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` },
      },
      required: ["args"],
    },
    execute: async ({ args, cwd, timeoutMs, ...rest }) => {
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
          env: process.env,
          ...(cwd ? { cwd: String(cwd) } : {}),
        });
        const body = [clip(stdout), stderr ? `[stderr]\n${clip(stderr)}` : ""].filter(Boolean).join("\n");
        return textPayload(`gh ${cleaned.join(" ")} 执行成功：\n\n${body || "（无输出）"}`);
      } catch (error) {
        if (error?.code === "ENOENT") return failurePayload(MISSING_HINT);
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

  await sdk.tools.register({
    name: "github_cli_login",
    description:
      "登录 GitHub CLI。两种方式：1) mode=token：配 github.com 的 Personal Access Token，经 stdin 交给 gh auth login --with-token（不落盘、不回显）；需要 scopes read:org 等按用户要求。2) mode=device：启动 gh auth login --web 设备码流程，返回一次性代码和授权页地址，用户在浏览器里确认即可；此调用立即返回，几分钟后用 github_cli_status 验证。选哪种取决于用户手边有什么。",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["token", "device"], description: "登录方式。" },
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
          return failurePayload("mode=token 需要一个有效的 PAT（至少 40 字符）。或改用 mode=device。");
        }
        return await new Promise((resolve) => {
          const child = spawn(command, ["auth", "login", "--hostname", host, "--git-protocol", "https", "--with-token"], {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("error", (error) => {
            resolve(failurePayload(`登录进程启动失败：${error?.message ?? error}`, error?.code === "ENOENT" ? MISSING_HINT : undefined));
          });
          child.on("close", (code) => {
            if (code === 0) resolve(textPayload(`gh auth login 成功（token 已交给 gh 自行保存，本 App 不保留副本）。\n${clip([out, err].filter(Boolean).join("\n"))}`));
            else resolve(failurePayload(`gh auth login 失败（退出码 ${code}）：\n${clip([out, err].filter(Boolean).join("\n")) || "无输出，常见原因是令牌无效或 scope 不足"}`, "令牌可在 https://github.com/settings/tokens 重新生成；或改用 mode=device。"));
          });
          child.stdin.on("error", () => {});
          child.stdin.end(String(token).trim());
        });
      }
      if (mode === "device") {
        try {
          const child = spawn(command, ["auth", "login", "--hostname", host, "--git-protocol", "https", "--web"], {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          });
          let buffer = "";
          const code = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("15 秒内未拿到设备码输出")), 15_000);
            const onData = (d) => {
              buffer += String(d);
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
          }).catch(() => null);
          if (!code) {
            return failurePayload("未能从 gh 输出中解析一次性代码。请在终端手动运行 gh auth login。", `原始输出：${clip(buffer)}`);
          }
          if (!code) {
            return failurePayload("未能从 gh 输出中解析一次性代码。请在终端手动运行 gh auth login。", `原始输出：${clip(buffer)}`);
          }
          child.unref();
          return textPayload(
            [
              "设备码登录流程已启动，gh 正在后台等待授权：",
              `一次性代码：${code}`,
              "授权页面：https://github.com/login/device",
              "请把代码和链接转告用户，用浏览器完成授权；完成后调用 github_cli_status 验证登录态。",
            ].join("\n"),
          );
        } catch (error) {
          return failurePayload(`设备码流程启动失败：${error?.message ?? error}`);
        }
      }
      return failurePayload("mode 只能是 token 或 device。");
    },
  });

  await sdk.logger.info("github-cli tools registered: status / run / login");
});
