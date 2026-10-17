import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { runTui } from "@zcode/tui";

declare const __CLI_VERSION__: string;

type TuiRuntimeModule = {
  runTui: typeof runTui;
};

type SeaModule = typeof import("node:sea");

type SeaTuiRuntimeFile = {
  mode?: number;
  path: string;
  sha256: string;
};

type SeaTuiRuntimeManifest = {
  files: SeaTuiRuntimeFile[];
  hash: string;
  target: string;
  version: 1;
};

const assetPrefix = "zcode-tui-runtime/";
const manifestAssetKey = `${assetPrefix}manifest.json`;
const packageEntryPath = "node_modules/@zcode/tui/dist/index.js";
const manifestFileName = "manifest.json";

export const loadTuiRuntime = async (): Promise<TuiRuntimeModule> => {
  const sea = await import("node:sea");

  if (!sea.isSea()) {
    // npm 发行包把 @zcode/tui 及其依赖 vendored 到 dist/vendor/node_modules（见
    // scripts/build-npm-package.mjs）；这些包不在公共 registry 上，只能走包内路径。
    // CJS bundle 里 __dirname 指向 dist/；tsx 开发态是 ESM，__dirname 未定义，
    // 没有 vendor 目录，回退裸 import 走 pnpm workspace 解析，保持原行为。
    if (typeof __dirname !== "undefined") {
      const vendoredEntry = join(__dirname, "vendor", packageEntryPath);
      if (existsSync(vendoredEntry)) {
        return await import(pathToFileURL(vendoredEntry).href);
      }
    }
    return await import("@zcode/tui");
  }

  const runtimeDirectory = await ensureSeaTuiRuntime(sea);
  return await import(pathToFileURL(join(runtimeDirectory, packageEntryPath)).href);
};

const ensureSeaTuiRuntime = async (sea: SeaModule): Promise<string> => {
  const manifest = readManifest(sea);
  const cacheDirectory = join(
    cacheBaseDirectory(),
    __CLI_VERSION__,
    manifest.target,
    manifest.hash,
  );
  const markerPath = join(cacheDirectory, manifestFileName);

  if (await isCacheCurrent(markerPath, manifest)) {
    return cacheDirectory;
  }

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(temporaryDirectory, {
    recursive: true,
  });

  for (const file of manifest.files) {
    const asset = sea.getRawAsset(`${assetPrefix}${file.path}`);
    const bytes = Buffer.from(asset);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== file.sha256) {
      throw new Error(`SEA TUI asset hash mismatch for ${file.path}`);
    }

    const outputPath = join(temporaryDirectory, file.path);
    await mkdir(dirname(outputPath), {
      recursive: true,
    });
    await writeFile(outputPath, bytes);
    await chmod(outputPath, file.mode ?? modeForPath(file.path));
  }

  await writeFile(markerPathForDirectory(temporaryDirectory), JSON.stringify(manifest, null, 2));
  await rm(cacheDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(dirname(cacheDirectory), {
    recursive: true,
  });
  await rename(temporaryDirectory, cacheDirectory);
  return cacheDirectory;
};

const readManifest = (sea: SeaModule): SeaTuiRuntimeManifest => {
  const raw = sea.getAsset(manifestAssetKey, "utf8");
  const manifest = JSON.parse(raw) as SeaTuiRuntimeManifest;
  if (manifest.version !== 1 || !manifest.hash || !Array.isArray(manifest.files)) {
    throw new Error("Invalid SEA TUI runtime manifest.");
  }
  return manifest;
};

const isCacheCurrent = async (
  markerPath: string,
  expected: SeaTuiRuntimeManifest,
): Promise<boolean> => {
  if (!existsSync(markerPath)) return false;

  try {
    const current = JSON.parse(await readFile(markerPath, "utf8")) as SeaTuiRuntimeManifest;
    return current.hash === expected.hash && current.target === expected.target;
  } catch {
    return false;
  }
};

const cacheBaseDirectory = (): string => {
  const home = homedir();
  if (platform() === "darwin" && home) {
    return join(home, "Library", "Caches", "zcode", "sea-assets");
  }
  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(home || tmpdir(), "AppData", "Local"),
      "zcode",
      "Cache",
      "sea-assets",
    );
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(home || tmpdir(), ".cache"),
    "zcode",
    "sea-assets",
  );
};

const markerPathForDirectory = (directory: string): string => join(directory, manifestFileName);

const modeForPath = (filePath: string): number =>
  /\.(?:dll|dylib|node|so)$/i.test(filePath) ? 0o755 : 0o644;
