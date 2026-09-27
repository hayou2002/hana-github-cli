#!/usr/bin/env node
// 纯逻辑层单元测试（无框架，直接断言）。运行：node lib/gh-core.test.mjs
import assert from "node:assert/strict";
import {
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
} from "../github-cli/lib/gh-core.js";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---- cleanEnv：剔除 8 个代理变量，且不改原对象 ----
test("cleanEnv 剔除全部代理变量", () => {
  const env = { PATH: "/x", HTTP_PROXY: "socks5://dead", https_proxy: "y", ALL_PROXY: "z", GH_CLI_PATH: "/gh" };
  const out = cleanEnv(env);
  assert.equal(out.PATH, "/x");
  assert.equal(out.GH_CLI_PATH, "/gh");
  for (const k of ["HTTP_PROXY", "https_proxy", "ALL_PROXY"]) assert.equal(out[k], undefined, `${k} 应被剔除`);
  assert.equal(env.HTTP_PROXY, "socks5://dead", "原对象不得被修改");
});

test("cleanEnv 对空输入安全", () => {
  assert.deepEqual(Object.keys(cleanEnv()), []);
});

// ---- ghExecutableCandidates ----
test("gh 候选路径含平台默认位置且以 gh 兜底", () => {
  const win = ghExecutableCandidates({ LOCALAPPDATA: "C:/Users/u/AppData/Local" }, "win32");
  assert.ok(win.some((p) => p.includes("Program Files/GitHub CLI/gh.exe")));
  assert.equal(win.at(-1), "gh");
});

test("GH_CLI_PATH 优先，且候选去重", () => {
  const list = ghExecutableCandidates({ GH_CLI_PATH: "/custom/gh" }, "linux");
  assert.equal(list[0], "/custom/gh");
  assert.equal(new Set(list).size, list.length, "不应有重复项");
});

// ---- clip ----
test("clip 不截断短文本、按上限截断长文本", () => {
  assert.equal(clip("abc", 10), "abc");
  const out = clip("x".repeat(50), 10);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.ok(out.includes("已截断"));
});

// ---- 版本 ----
test("parseGhVersion 提取语义化版本", () => {
  assert.equal(parseGhVersion("gh version 2.101.0 (2026-09-15)"), "2.101.0");
  assert.equal(parseGhVersion("gh version 2.101.0"), "2.101.0");
  assert.equal(parseGhVersion("nope"), null);
});

test("compareVersions 正确比较", () => {
  assert.equal(compareVersions("2.101.0", "2.101.0"), 0);
  assert.equal(compareVersions("2.102.0", "2.101.9"), 1);
  assert.equal(compareVersions("2.9.0", "2.10.0"), -1);
  assert.equal(compareVersions("3.0", "2.99.99"), 1);
});

// ---- 登录态解析 ----
test("parseAuthStatus 取 active 账号", () => {
  const json = JSON.stringify({
    hosts: {
      "github.com": [
        { state: "success", active: false, login: "old", host: "github.com" },
        { state: "success", active: true, login: "hayou2002", host: "github.com", scopes: "repo", gitProtocol: "https" },
      ],
    },
  });
  const r = parseAuthStatus(json);
  assert.equal(r.loggedIn, true);
  assert.equal(r.account.login, "hayou2002");
  assert.equal(r.account.protocol, "https");
});

test("parseAuthStatus 未登录 / 非法 JSON 都安全", () => {
  assert.equal(parseAuthStatus('{"hosts":{}}').loggedIn, false);
  assert.equal(parseAuthStatus("not json").loggedIn, false);
  assert.equal(parseAuthStatus(undefined).loggedIn, false);
});

// ---- 设备码 ----
test("extractDeviceCode 兼容两种输出格式", () => {
  assert.equal(extractDeviceCode("! One-time code (2DD1-ADB2) copied to clipboard"), "2DD1-ADB2");
  assert.equal(extractDeviceCode("First copy your one-time code: ABCD-1234"), "ABCD-1234");
  assert.equal(extractDeviceCode("nothing here"), null);
});

test("looksLikeNetworkFailure 识别网络失败", () => {
  assert.equal(looksLikeNetworkFailure("wsarecv: An existing connection was forcibly closed"), true);
  assert.equal(looksLikeNetworkFailure("connection timed out"), true);
  assert.equal(looksLikeNetworkFailure("cancelled by user"), false);
});

// ---- 镜像与 URL ----
test("msiUrl 拼接正确（直连与镜像）", () => {
  const direct = msiUrl("2.101.0");
  assert.equal(direct, "https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_windows_amd64.msi");
  assert.ok(msiUrl("2.101.0", "https://gh-proxy.com/").startsWith("https://gh-proxy.com/https://github.com/"));
});

test("mirrorLabel 显示友好名", () => {
  assert.equal(mirrorLabel(""), "直连");
  assert.equal(mirrorLabel("https://gh-proxy.com/"), "gh-proxy.com");
});

test("rankMirrorResults 过滤无效并降序", () => {
  const ranked = rankMirrorResults([
    { base: "", speed: 100 },
    { base: "a", speed: 0 },
    { base: "b", speed: 300 },
    { base: "c", speed: NaN },
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].base, "b");
  assert.equal(ranked[1].base, "");
});

// ---- 提权 ----
test("buildElevateCommand 生成 RunAs 命令，含空格参数按 Windows 规则加双引号", () => {
  const cmd = buildElevateCommand("msiexec.exe", ["/i", "C:\\tmp\\a b.msi", "/qn"]);
  assert.ok(cmd.includes("-Verb RunAs"));
  assert.ok(cmd.includes("-Wait"));
  // 关键：参数不能被逗号分隔（PS 5.1 的 -ArgumentList 传数组会拆散含空格参数），
  // 而要把整串作为一个带单引号的字符串传入，其中含空格项用双引号包裹。
  assert.ok(cmd.includes('-ArgumentList \'/i "C:\\tmp\\a b.msi" /qn\''), "整串应作为一个字符串传入，含空格项加双引号");
  assert.ok(!cmd.includes("',"), "参数不应用逗号分隔");
});

test("buildElevateCommand 无空格参数不加多余引号 / 含单引号项可安全转义", () => {
  const c1 = buildElevateCommand("msiexec.exe", ["/x", "{A1B2C3D4-1111-2222-3333-444455556666}", "/qb"]);
  assert.ok(c1.includes('-ArgumentList \'/x {A1B2C3D4-1111-2222-3333-444455556666} /qb\''));
  const c2 = buildElevateCommand("msiexec.exe", ["/i", "C:\\o'brien data\\gh.msi"]);
  // 外层单引号包裹，内部单引号按 PS 规则转义为 ''；含空格项整体用双引号包裹
  assert.ok(c2.includes('"C:\\o\'\'brien data\\gh.msi"'), "含单引号的含空格路径应双引号包裹且单引号转义为 ''");
});

// ---- 产品码 ----
test("parseProductCode 提取 GUID", () => {
  assert.equal(parseProductCode("{05425DD6-E9FE-4AEE-B289-8B61429F042A}"), "{05425DD6-E9FE-4AEE-B289-8B61429F042A}");
  assert.equal(parseProductCode("no guid here"), null);
});

// ---- 运行 ----
let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
console.log(`\n${pass}/${cases.length} 通过${failed ? `，${failed} 失败` : ""}`);
process.exit(failed ? 1 : 0);

