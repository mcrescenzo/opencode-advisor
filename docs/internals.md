# Internals

Implementation notes for readers extending or auditing `advisor.js` directly.
Most users do not need this file — see the README for usage and
[`security-model.md`](security-model.md) for the permission/data-flow contract.

## Hooks

This plugin registers exactly four hooks:

| Hook | Behavior |
| --- | --- |
| `config` | Mutates the live config in place: resolves the advisor model (env override, then an existing `advisor-strategist` agent model, then the configured default model) and installs the hidden `advisor-strategist` agent with its locked-down permission set. |
| `tool` | Registers the single `advisor` tool: budgets calls per session, snapshots the parent transcript, spins up a child session under `advisor-strategist`, and returns the distilled advice text. |
| `chat.params` | For prompts sent to the `advisor-strategist` agent on an OpenAI provider only, sets the provider-specific `reasoningEffort` option to `high`. No-op for every other agent or provider. |
| `dispose` | No-op. The per-session call-budget counter is module-level and intentionally survives plugin factory disposal so one disposed instance cannot refund budget spent by another active instance. |

See `AGENTS.md` at the repo root for the full design rationale and the
non-negotiable invariants an editor of `advisor.js` must preserve.
