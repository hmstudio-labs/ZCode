#!/usr/bin/env node
// 把构建产物组装成可发布到 npmjs.com 的自包含 npm 包：
//
//   <out>/package.json            公开包名、bin、files、engines、publishConfig
//   <out>/README.md               简短用法
//   <out>/LICENSE                 仓库根 LICENSE
//   <out>/dist/zcode.cjs          buildCli 产物（含 shebang、755）
//   <out>/dist/THIRD-PARTY-NOTICES.md
//   <out>/dist/provider/          内置 provider 配置
//   <out>/dist/vendor/node_modules/  vendored 依赖树（@zcode/tui、opentui 原生包、
//                                    playwright-core、koffi、react 等）
//
// vendored 依赖全在私有 workspace / 不存在于公共 registry，必须随包携带；
// 运行时解析见 src/tui-runtime-loader.ts 与 src/sea-playwright-runtime.ts 的
// vendored 优先分支。前置条件：`pnpm --dir apps/zcode-cli build` 已产出 dist/。
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { opentuiNativePackageForTarget } from "./sea-tui-assets.mjs";
import { supportedTargets } from "./sea-targets.mjs";
import {
  resolvePackageJsonPath,
  stageTuiRuntime,
} from "../../../../../scripts/zcode-distribution/assets.mjs";
import { readRootPackageVersion } from "./build.mjs";

const cliRoot = resolve(import.meta.dirname, "..");
const zcodeCliRoot = resolve(cliRoot, "..", "..");
const repositoryRoot = resolve(zcodeCliRoot, "..", "..");
const defaultOutDirectory = "dist-npm";
export const defaultPackageName = "@kyvro/zcode-cli";
const bundleTargetEngines = ">=22.16.0";

const usage = `Usage:
  node scripts/build-npm-package.mjs --out <dir> [--name <pkg>] [--version <v>] [--repository <url>]

Options:
  --out <dir>          Staging output directory (required).
  --name <pkg>         Public npm package name. Defaults to ${defaultPackageName}.
  --version <v>        Published version. Defaults to apps/zcode-cli/package.json,
                       the same source build.mjs injects as __CLI_VERSION__.
  --repository <url>   Optional git repository URL written into package.json.
  --help, -h           Show this help.
`;

export const parseNpmPackageArgs = (argv) => {
  const options = {
    help: false,
    name: defaultPackageName,
    out: defaultOutDirectory,
    repository: undefined,
    version: undefined,
  };

  const readValue = (arg, index) => {
    if (arg.includes("=")) {
      return { nextIndex: index, value: arg.slice(arg.indexOf("=") + 1) };
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    return { nextIndex: index + 1, value };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--out" || arg.startsWith("--out=")) {
      const { nextIndex, value } = readValue(arg, index);
      options.out = value;
      index = nextIndex;
      continue;
    }
    if (arg === "--name" || arg.startsWith("--name=")) {
      const { nextIndex, value } = readValue(arg, index);
      if (!/^@[a-z0-9][a-z0-9-._]*\/[a-z0-9][a-z0-9-._]*$/.test(value)) {
        throw new Error(`Invalid npm package name "${value}". Expected a scoped name like @scope/zcode-cli.`);
      }
      options.name = value;
      index = nextIndex;
      continue;
    }
    if (arg === "--version" || arg.startsWith("--version=")) {
      const { nextIndex, value } = readValue(arg, index);
      options.version = value;
      index = nextIndex;
      continue;
    }
    if (arg === "--repository" || arg.startsWith("--repository=")) {
      const { nextIndex, value } = readValue(arg, index);
      options.repository = value;
      index = nextIndex;
      continue;
    }
    throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
  }

  return options;
};

// 纯函数：npm 包 manifest。dependencies 刻意为空——运行时依赖全部 vendored，
// 安装方不得再从 registry 拉取任何私有包。
export const buildNpmPackageManifest = ({ name, version, repository }) => ({
  name,
  version,
  description: "zcode CLI as a self-contained npm package with vendored runtime dependencies.",
  license: "Apache-2.0",
  ...(repository ? { repository: { type: "git", url: repository } } : {}),
  bin: { zcode: "./dist/zcode.cjs" },
  files: ["dist"],
  // bundle target 是 node22（见 build.mjs），engines 与之对齐，给安装方明确的运行时下限。
  engines: { node: bundleTargetEngines },
  publishConfig: { access: "public" },
  dependencies: {},
});

export const readmeSource = (name) => `# ${name}

Self-contained npm distribution of the zcode CLI. The TUI runtime, Playwright
driver and all native modules are vendored under \`dist/vendor\`, so installation
needs no postinstall step and no access to any private registry.

## Install

\`\`\`
npm install -g ${name}
\`\`\`

## Run

\`\`\`
zcode --version
zcode --help
\`\`\`

Requires Node.js ${bundleTargetEngines}.
`;

// 静态断言：vendor 树缺任何一个必需包都要在打包前失败，而不是发布后用户启动才报错。
export const assertVendoredPackageTree = async (vendorNodeModules) => {
  const requiredEntries = [
    join("@zcode", "tui", "dist", "index.js"),
    join("playwright-core", "package.json"),
    ...supportedTargets.map((target) =>
      join(...opentuiNativePackageForTarget(target).split("/"), "package.json"),
    ),
  ];

  const missing = [];
  for (const entry of requiredEntries) {
    const entryPath = resolve(vendorNodeModules, entry);
    if (!existsSync(entryPath)) {
      missing.push(relative(vendorNodeModules, entryPath));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Vendored package tree is missing required entries:\n  ${missing.join("\n  ")}`,
    );
  }
};

const assertFileExists = async (filePath, hint) => {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`Missing build artifact ${filePath}. ${hint}`);
  }
};

// 复制 playwright-core 时剥离嵌套 node_modules/.git，避免把无关体积带进发行包
//（与 assets.mjs 的 shouldCopyPackagePath 同一规则）。
const shouldCopyPlaywrightPath = (packageDirectory, source) => {
  const rel = relative(packageDirectory, source);
  if (!rel) {
    return true;
  }
  const parts = rel.split(sep);
  return !parts.includes("node_modules") && !parts.includes(".git");
};

export const buildNpmPackage = async ({
  name,
  out,
  repository,
  version: versionOverride,
} = {}) => {
  const version =
    versionOverride ?? (await readRootPackageVersion({ root: zcodeCliRoot }));

  const cliDistDirectory = resolve(cliRoot, "dist");
  const bundleFile = resolve(cliDistDirectory, "zcode.cjs");
  await assertFileExists(
    bundleFile,
    "Run `pnpm --dir apps/zcode-cli build` before staging the npm package.",
  );

  const outRoot = resolve(out);
  const outDist = resolve(outRoot, "dist");
  const vendorNodeModules = resolve(outDist, "vendor", "node_modules");
  await rm(outRoot, { force: true, recursive: true });
  await mkdir(vendorNodeModules, { recursive: true });

  // 1) 复制 bundle 与伴随产物。
  await cp(bundleFile, resolve(outDist, "zcode.cjs"));
  await chmod(resolve(outDist, "zcode.cjs"), 0o755);
  await cp(resolve(cliDistDirectory, "THIRD-PARTY-NOTICES.md"), resolve(outDist, "THIRD-PARTY-NOTICES.md"));
  await cp(resolve(cliDistDirectory, "provider"), resolve(outDist, "provider"), { recursive: true });

  // 2) TUI 运行时闭包：复用 SEA 的资产收集（6 个 target 全平台，冲突即报错），
  //    产出到临时 packageRoot 的 agent/node_modules，再整体移入 vendor 树。
  const tuiStagingRoot = await mkdtemp(join(tmpdir(), "zcode-npm-tui-"));
  try {
    await stageTuiRuntime(resolve(tuiStagingRoot, "package"));
    await cp(
      resolve(tuiStagingRoot, "package", "agent", "node_modules"),
      vendorNodeModules,
      { recursive: true },
    );
  } finally {
    await rm(tuiStagingRoot, { force: true, recursive: true });
  }

  // 3) playwright-core：定位真实目录（pnpm 链接后可能是 store 路径）后整目录复制。
  const requireFromCli = createRequire(resolve(zcodeCliRoot, "packages", "cli", "package.json"));
  const playwrightPackageJsonPath = await resolvePackageJsonPath(requireFromCli, "playwright-core");
  await cp(dirname(playwrightPackageJsonPath), resolve(vendorNodeModules, "playwright-core"), {
    dereference: true,
    force: true,
    recursive: true,
    filter: (source) => shouldCopyPlaywrightPath(dirname(playwrightPackageJsonPath), source),
  });

  // 4) 断言 vendor 树完整。
  await assertVendoredPackageTree(vendorNodeModules);

  // 5) 生成 manifest 与文档。
  await writeFile(
    resolve(outRoot, "package.json"),
    `${JSON.stringify(buildNpmPackageManifest({ name, version, repository }), null, 2)}\n`,
  );
  await writeFile(resolve(outRoot, "README.md"), readmeSource(name));
  await cp(resolve(repositoryRoot, "LICENSE"), resolve(outRoot, "LICENSE"));

  return { name, outRoot, version, vendorNodeModules };
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const options = parseNpmPackageArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
  } else {
    const result = await buildNpmPackage(options);
    console.log(
      `[build-npm-package] staged ${result.name}@${result.version} at ${result.outRoot}`,
    );
  }
}
