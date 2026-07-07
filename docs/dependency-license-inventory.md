# Dependency license inventory and notice-risk record

This inventory was prepared for the `@mcrescenzo/opencode-advisor` public
release review. It records dependency metadata and notice-risk observations; it
is not legal advice and does not claim legal approval.

## Scope and sources

- Root package reviewed: `@mcrescenzo/opencode-advisor@0.1.0`.
- Direct runtime dependency from `package.json`: `@opencode-ai/plugin@1.17.7`.
- Transitive packages reviewed from `bun.lock` package entries.
- Installed package metadata source: each package's installed
  `node_modules/<package>/package.json`, plus license/notice-like files matching
  `LICENSE`, `LICENCE`, `COPYING`, or `NOTICE` when installed locally.
- Registry metadata source for platform-specific optional packages not installed
  on this Linux machine: `npm view <package>@3.0.4 license repository.url --json`.
- Package artifact check: `npm pack --dry-run --json`.

## Summary findings

- The npm package artifact currently ships this plugin's files only; it does not
  bundle installed third-party dependency code from `node_modules`.
- License fields found across locked runtime dependencies: MIT, ISC, and
  Apache-2.0.
- No installed dependency directory contained a `NOTICE` file in this review.
- Many MIT/ISC packages include a license file in their installed package. Two
  Apache-2.0 packages were identified: `detect-libc@2.1.2` includes `LICENSE`;
  `kubernetes-types@1.30.0` declares `Apache-2.0` in `package.json` but did not
  include a local notice-like file in the installed package reviewed here.
- No incompatible license was identified from the package metadata reviewed.
- If a future release bundles dependency source or binaries into this package's
  published artifact, regenerate this inventory and create a third-party notice
  file before publishing. This review only covers the current unbundled package
  artifact and lockfile state.

## Inventory

| Package | Version | Relationship | Metadata source | License field | Notice/license files discovered |
| --- | --- | --- | --- | --- | --- |
| `@opencode-ai/plugin` | 1.17.7 | Direct runtime dependency | installed `package.json` | MIT | none discovered |
| `@opencode-ai/sdk` | 1.17.7 | Transitive via `@opencode-ai/plugin` | installed `package.json` | MIT | none discovered |
| `zod` | 4.1.8 | Transitive via `@opencode-ai/plugin` | installed `package.json` | MIT | `LICENSE` |
| `cross-spawn` | 7.0.6 | Transitive via `@opencode-ai/sdk` | installed `package.json` | MIT | `LICENSE` |
| `path-key` | 3.1.1 | Transitive via `cross-spawn` | installed `package.json` | MIT | `license` |
| `shebang-command` | 2.0.0 | Transitive via `cross-spawn` | installed `package.json` | MIT | `license` |
| `shebang-regex` | 3.0.0 | Transitive via `shebang-command` | installed `package.json` | MIT | `license` |
| `which` | 2.0.2 | Transitive via `cross-spawn` | installed `package.json` | ISC | `LICENSE` |
| `isexe` | 2.0.0 | Transitive via `which` | installed `package.json` | ISC | `LICENSE` |
| `effect` | 4.0.0-beta.74 | Transitive via `@opencode-ai/plugin` | installed `package.json` | MIT | `LICENSE` |
| `@standard-schema/spec` | 1.1.0 | Transitive via `effect` | installed `package.json` | MIT | `LICENSE` |
| `fast-check` | 4.8.0 | Transitive via `effect` | installed `package.json` | MIT | `LICENSE` |
| `pure-rand` | 8.4.1 | Transitive via `fast-check` | installed `package.json` | MIT | `LICENSE` |
| `find-my-way-ts` | 0.1.6 | Transitive via `effect` | installed `package.json` | MIT | `LICENSE` |
| `ini` | 7.0.0 | Transitive via `effect` | installed `package.json` | ISC | `LICENSE` |
| `kubernetes-types` | 1.30.0 | Transitive via `effect` | installed `package.json` | Apache-2.0 | none discovered |
| `msgpackr` | 2.0.4 | Transitive via `effect` | installed `package.json` | MIT | `LICENSE` |
| `msgpackr-extract` | 3.0.4 | Optional transitive via `msgpackr` | installed `package.json` | MIT | `LICENSE` |
| `@msgpackr-extract/msgpackr-extract-linux-x64` | 3.0.4 | Optional platform package via `msgpackr-extract` | installed `package.json` | MIT | none discovered |
| `@msgpackr-extract/msgpackr-extract-darwin-arm64` | 3.0.4 | Optional platform package via `msgpackr-extract` | npm registry metadata | MIT | not installed locally |
| `@msgpackr-extract/msgpackr-extract-darwin-x64` | 3.0.4 | Optional platform package via `msgpackr-extract` | npm registry metadata | MIT | not installed locally |
| `@msgpackr-extract/msgpackr-extract-linux-arm` | 3.0.4 | Optional platform package via `msgpackr-extract` | npm registry metadata | MIT | not installed locally |
| `@msgpackr-extract/msgpackr-extract-linux-arm64` | 3.0.4 | Optional platform package via `msgpackr-extract` | npm registry metadata | MIT | not installed locally |
| `@msgpackr-extract/msgpackr-extract-win32-x64` | 3.0.4 | Optional platform package via `msgpackr-extract` | npm registry metadata | MIT | not installed locally |
| `node-gyp-build-optional-packages` | 5.2.2 | Transitive via `msgpackr-extract` | installed `package.json` | MIT | `LICENSE` |
| `detect-libc` | 2.1.2 | Transitive via `node-gyp-build-optional-packages` | installed `package.json` | Apache-2.0 | `LICENSE` |
| `multipasta` | 0.2.7 | Transitive via `effect` | installed `package.json` | MIT | `LICENSE` |
| `toml` | 4.1.1 | Transitive via `effect` | installed `package.json` | MIT | `LICENSE` |
| `uuid` | 14.0.1 | Transitive via `effect` | installed `package.json` | MIT | `LICENSE.md` |
| `yaml` | 2.9.0 | Transitive via `effect` | installed `package.json` | ISC | `LICENSE` |

## Validation commands run

```sh
node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const text = fs.readFileSync('bun.lock', 'utf8');
const lines = text.split(/\n/);
const rows = [];
for (const line of lines) {
  const match = line.match(/^\s+"([^"]+)": \["([^"]+)@([^@"]+)"/);
  if (!match) continue;
  const [, name, specName, version] = match;
  let pkgPath;
  if (name.startsWith('@')) {
    const [scope, rest] = name.split('/');
    pkgPath = path.join('node_modules', scope, rest, 'package.json');
  } else {
    pkgPath = path.join('node_modules', name, 'package.json');
  }
  let license = '(not installed)';
  let noticeFiles = [];
  let repository = '';
  const packageExists = fs.existsSync(pkgPath);
  if (packageExists) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    license = pkg.license ?? (pkg.licenses ? JSON.stringify(pkg.licenses) : '(missing)');
    repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    const dir = path.dirname(pkgPath);
    noticeFiles = fs.readdirSync(dir).filter(f => /^(license|licence|copying|notice)(\.|$)/i.test(f));
  }
  rows.push({ name, version, license, packageExists, noticeFiles: noticeFiles.join(', ') || '(none)', repository });
}
for (const r of rows) console.log(JSON.stringify(r));
NODE

npm view @msgpackr-extract/msgpackr-extract-darwin-arm64@3.0.4 license repository.url --json
npm view @msgpackr-extract/msgpackr-extract-darwin-x64@3.0.4 license repository.url --json
npm view @msgpackr-extract/msgpackr-extract-linux-arm@3.0.4 license repository.url --json
npm view @msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 license repository.url --json
npm view @msgpackr-extract/msgpackr-extract-win32-x64@3.0.4 license repository.url --json

npm pack --dry-run --json
npm test
```
