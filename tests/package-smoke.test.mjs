import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const packageRoot = join(import.meta.dirname, "..");
const readProjectFile = (relativePath) => readFileSync(join(packageRoot, relativePath), "utf8");
const execFileAsync = promisify(execFile);

test("package manifest exposes the published plugin boundary", () => {
  const manifest = JSON.parse(readProjectFile("package.json"));
  const files = new Set(manifest.files);

  assert.equal(manifest.name, "@mcrescenzo/opencode-advisor");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.main, "./advisor.js");
  assert.deepStrictEqual(manifest.exports, { ".": "./advisor.js" });
  for (const required of [
    "advisor.js",
    "advisor-core.js",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
  ]) {
    assert.ok(files.has(required), `${required} should be in the package allowlist`);
    assert.equal(statSync(join(packageRoot, required)).isFile(), true, `${required} should exist`);
  }

  const normalizedTarget = manifest.main.replace(/^\.\//, "");
  assert.ok(files.has(normalizedTarget), `${manifest.main} must be included by files`);
  assert.equal(statSync(join(packageRoot, normalizedTarget)).isFile(), true, `${manifest.main} must exist`);

  for (const excluded of [
    "AGENTS.md",
    "bun.lock",
    "docs/dependency-license-inventory.md",
    "tests/advisor-core.test.mjs",
    "tests/advisor-plugin.test.mjs",
    "tests/package-smoke.test.mjs",
  ]) {
    assert.ok(!files.has(excluded), `${excluded} should not be in the package allowlist`);
  }
});

test("npm pack dry-run includes only the intended package artifact files", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json"],
    { cwd: packageRoot, maxBuffer: 1024 * 1024 },
  );
  const [artifact] = JSON.parse(stdout);
  const packedFiles = new Set(artifact.files.map((file) => file.path));
  const expectedFiles = new Set([
    "advisor.js",
    "advisor-core.js",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "package.json",
  ]);

  assert.deepStrictEqual([...packedFiles].sort(), [...expectedFiles].sort());

  for (const required of expectedFiles) {
    assert.ok(packedFiles.has(required), `${required} should be included in npm pack output`);
  }

  for (const excluded of [
    "AGENTS.md",
    "bun.lock",
    ".repo-review/",
    "tests/",
    "docs/dependency-license-inventory.md",
    "tests/advisor-core.test.mjs",
    "tests/advisor-plugin.test.mjs",
    "tests/package-smoke.test.mjs",
  ]) {
    assert.ok(
      [...packedFiles].every((file) => file !== excluded && !file.startsWith(excluded)),
      `${excluded} should not be included in npm pack output`,
    );
  }
});

test("package manifest omits packageManager and CI pins a concrete Bun version", () => {
  const manifest = JSON.parse(readProjectFile("package.json"));
  const workflow = readProjectFile(".github/workflows/ci.yml");
  const workflowBunVersion = workflow.match(/^\s*bun-version:\s*([^\s#]+)/m)?.[1];

  // The published family standard for this plugin family drops the
  // packageManager field from package.json; CI still pins Bun explicitly via
  // the setup-bun action input, so assert that pin is a concrete version
  // rather than cross-checking it against a field that no longer exists.
  assert.equal(manifest.packageManager, undefined, "packageManager should not be declared");
  assert.match(workflowBunVersion ?? "", /^\d+\.\d+\.\d+$/, "CI should pin a concrete Bun version");
});

test("CI third-party actions are pinned to full commit SHAs", () => {
  const workflow = readProjectFile(".github/workflows/ci.yml");
  const usesEntries = Array.from(
    workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/gm),
    (match) => ({ spec: match[1], comment: match[2] }),
  );

  assert.deepStrictEqual(usesEntries, [
    {
      spec: "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd",
      comment: "v5",
    },
    {
      spec: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      comment: "v2",
    },
  ]);

  for (const { spec } of usesEntries) {
    assert.match(spec, /@[0-9a-f]{40}$/);
  }
});
