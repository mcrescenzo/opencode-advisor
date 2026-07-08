# Contributing

Thanks for improving `@mcrescenzo/opencode-advisor`. This is a standalone
opencode plugin repository; contributor instructions should work from this
checkout alone.

## Toolchain and compatibility

This package is tested against:

- `@opencode-ai/plugin@^1.17.7` (the plugin API dependency range in
  `package.json`).
- Node.js 20.11.0 or newer for the local syntax and unit-test commands (see
  `engines` in `package.json`).
- Bun as the contributor package manager.

The repository tracks `bun.lock`, so Bun is the canonical install path for
contributors. Do not add or refresh an npm `package-lock.json` unless the
project intentionally changes its lockfile policy. The package scripts use
portable `node` commands, so they can be invoked by other package managers when
needed, but the release candidate lockfile source of truth is `bun.lock`.

## Registering a source checkout

For local development from a source checkout, register the plugin by a
relative path from the config file to `advisor.js` instead of by package
name:

```json
{
  "plugin": [
    "./plugins/advisor/advisor.js"
  ]
}
```

(End users installing the published package register by package name instead
— see the README's Quick Start.)

## Development setup

1. Install dependencies with `bun install`.
2. Run the test suite:

   ```sh
   bun run test
   ```

   This runs the regression suite (`node --test tests/*.test.mjs`), covering
   pure helper logic, mocked plugin hook behavior, and package/export smoke
   checks. No live opencode runtime or model calls are required — the
   entry-hook tests are intentional because the permission and child-session
   isolation behavior lives at the plugin boundary. You can also invoke the
   suite directly:

   ```sh
   node --test tests/*.test.mjs
   ```

3. Optionally run the focused syntax-only gate:

   ```sh
   bun run check
   ```

   which is equivalent to:

   ```sh
   node --check advisor.js && node --check advisor-core.js
   ```

## Dependency license audit

See [`docs/dependency-license-inventory.md`](docs/dependency-license-inventory.md)
for the dependency license inventory and notice-risk record prepared for public
release. Update it alongside any dependency change; it is factual inventory
only, not legal advice or approval.

## Release notes

Notable changes are tracked in [`CHANGELOG.md`](CHANGELOG.md) following the
spirit of Keep a Changelog with semantic versioning for published releases.
Update it as part of any user-visible change.

## Pull request expectations

- Avoid new runtime dependencies without maintainer review.
- Keep `advisor-core.js` free of any `@opencode-ai/plugin` import — it must
  stay unit-testable under plain Node.
- Preserve the module-level `callCounts` budget registry in `advisor.js`; do
  not move it into factory-closure scope.
- Preserve the advisor's read-only permission invariants (no edit-family
  tools, no recursive `advisor` calls, no destructive shell commands) — see
  `AGENTS.md` for the full list.
- Add or update tests alongside any behavior change, and make sure
  `node --test tests/*.test.mjs` passes before opening a pull request.
- Keep documentation (`README.md`, `AGENTS.md`) in sync with any behavior or
  configuration change.

See `AGENTS.md` for the load-bearing design rationale and invariants.
