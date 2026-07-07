# Contributing

Thanks for improving `@mcrescenzo/opencode-advisor`. This is a standalone
opencode plugin repository; contributor instructions should work from this
checkout alone.

## Development setup

1. Install dependencies with `bun install`.
2. Run the test suite:

   ```sh
   node --test tests/*.test.mjs
   ```

3. Optionally run the focused syntax check:

   ```sh
   node --check advisor.js && node --check advisor-core.js
   ```

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
