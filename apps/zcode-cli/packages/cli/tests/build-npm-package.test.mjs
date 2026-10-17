import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertVendoredPackageTree,
  buildNpmPackageManifest,
  defaultPackageName,
  parseNpmPackageArgs,
  readmeSource,
} from "../scripts/build-npm-package.mjs";

test("npm package manifest is public, self-contained and versioned like the CLI bundle", () => {
  const manifest = buildNpmPackageManifest({
    name: "@scope/zcode-cli",
    version: "1.2.3",
    repository: "https://github.com/example/zcode",
  });

  assert.equal(manifest.name, "@scope/zcode-cli");
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.bin, { zcode: "./dist/zcode.cjs" });
  assert.deepEqual(manifest.files, ["dist"]);
  assert.deepEqual(manifest.engines, { node: ">=22.16.0" });
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  // 运行时依赖全部 vendored，安装方不得再从 registry 拉取任何包。
  assert.deepEqual(manifest.dependencies, {});
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/example/zcode",
  });
});

test("npm package manifest omits repository metadata when no URL is provided", () => {
  const manifest = buildNpmPackageManifest({
    name: defaultPackageName,
    version: "0.0.0",
    repository: undefined,
  });

  assert.equal(manifest.repository, undefined);
  assert.equal("repository" in manifest, false);
});

test("staging args default to the placeholder package and bundle version source", () => {
  const options = parseNpmPackageArgs([]);

  assert.equal(options.out, "dist-npm");
  assert.equal(options.name, defaultPackageName);
  assert.equal(options.version, undefined);
  assert.equal(options.repository, undefined);
  assert.equal(options.help, false);
});

test("staging args accept space and equals forms and reject unknown options", () => {
  const options = parseNpmPackageArgs([
    "--out",
    "/tmp/stage",
    "--name=@scope/zcode-cli",
    "--version",
    "9.9.9",
    "--repository",
    "https://github.com/example/zcode",
  ]);

  assert.equal(options.out, "/tmp/stage");
  assert.equal(options.name, "@scope/zcode-cli");
  assert.equal(options.version, "9.9.9");
  assert.equal(options.repository, "https://github.com/example/zcode");

  assert.throws(() => parseNpmPackageArgs(["--unknown"]), /Unknown option/);
  assert.throws(() => parseNpmPackageArgs(["--version"]), /Missing value/);
  assert.throws(
    () => parseNpmPackageArgs(["--name", "zcode-cli"]),
    /Invalid npm package name/,
  );
});

test("vendored tree assertion accepts a tree with every required runtime package", async () => {
  const vendorNodeModules = await mkdtemp(join(tmpdir(), "zcode-vendor-ok-"));

  try {
    const requiredFiles = [
      join("@zcode", "tui", "dist", "index.js"),
      join("playwright-core", "package.json"),
      join("@mbears", "opentui-core-darwin-arm64", "package.json"),
      join("@mbears", "opentui-core-darwin-x64", "package.json"),
      join("@mbears", "opentui-core-linux-arm64", "package.json"),
      join("@mbears", "opentui-core-linux-x64", "package.json"),
      join("@mbears", "opentui-core-win32-arm64", "package.json"),
      join("@mbears", "opentui-core-win32-x64", "package.json"),
    ];
    for (const file of requiredFiles) {
      await mkdir(resolve(vendorNodeModules, dirname(file)), { recursive: true });
      await writeFile(resolve(vendorNodeModules, file), "");
    }

    await assertVendoredPackageTree(vendorNodeModules);
  } finally {
    await rm(vendorNodeModules, { force: true, recursive: true });
  }
});

test("vendored tree assertion reports every missing runtime package", async () => {
  const vendorNodeModules = await mkdtemp(join(tmpdir(), "zcode-vendor-bad-"));

  try {
    await mkdir(resolve(vendorNodeModules, "@zcode", "tui", "dist"), { recursive: true });
    await writeFile(resolve(vendorNodeModules, "@zcode", "tui", "dist", "index.js"), "");

    await assert.rejects(
      assertVendoredPackageTree(vendorNodeModules),
      (error) => {
        assert.match(error.message, /Vendored package tree is missing/);
        assert.match(error.message, /playwright-core/);
        assert.match(error.message, /opentui-core-linux-x64/);
        // 已存在的 TUI 入口不应出现在缺失清单里。
        assert.doesNotMatch(error.message, /@zcode\/tui/);
        return true;
      },
    );
  } finally {
    await rm(vendorNodeModules, { force: true, recursive: true });
  }
});

test("readme documents the published package name", () => {
  const readme = readmeSource("@scope/zcode-cli");

  assert.match(readme, /# @scope\/zcode-cli/);
  assert.match(readme, /npm install -g @scope\/zcode-cli/);
  assert.match(readme, /dist\/vendor/);
});
