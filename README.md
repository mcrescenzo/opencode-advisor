# advisor

Coding agents are built to keep moving — even at the moments where the better
move is to stop and think: a broad or risky refactor, a test that keeps
failing for reasons that aren't obvious, a fork in the road between two
architectures, an unfamiliar dependency's API. Left alone, an executor agent
either guesses and presses on, or burns its own context exploring options it
will mostly discard. `advisor` gives that executor a second opinion on
demand: it asks a focused question and gets back a short, distilled,
actionable answer, without stalling the task or filling the executor's own
conversation with the exploratory research that produced it.

Under the hood, `advisor` is an opencode plugin that registers a single
**`advisor` tool**: a budgeted, read-only child-session strategist. When an
executor agent that has been explicitly allowed to use `advisor` reaches a
non-obvious decision, it calls the tool. The plugin snapshots the executor's
recent transcript, spins up a **child session** under a hidden,
high-capability `advisor-strategist` agent, and returns only the distilled
advice text. The advisor can inspect files and search code; network and MCP
documentation tools are denied by default and require explicit operator
opt-in. The advisor **cannot edit files or run destructive shell commands**,
and the executor's context is never polluted with the advisor's intermediate
research.

## Quick Start

1. **Register the plugin.** Add the package name to `opencode.json` under the
   singular `"plugin"` key — opencode installs it automatically before
   loading it:

   ```json
   {
     "plugin": [
       "@mcrescenzo/opencode-advisor"
     ]
   }
   ```

   opencode loads plugins once at startup, so restart opencode after adding
   or changing this entry.

2. **Opt in the agents that should have it.** Registering the plugin makes
   the `advisor` tool available, but it does not grant any agent permission
   to call it — that stays an explicit, per-agent trust decision (the child
   session can read and search your workspace under its own hardened
   policy). Grant it to the agents that should be able to consult the
   advisor, for example:

   ```json
   {
     "agent": {
       "build": {
         "permission": {
           "advisor": "allow"
         }
       }
     }
   }
   ```

3. **That's it.** Any opted-in executor agent can now call the `advisor`
   tool mid-task with a `question` (required) and optional `context` — see
   the example below for what that looks like in practice.

## Example: a mid-refactor decision

Say an executor agent is partway through refactoring a payments module and
hits a genuine fork in the road. It calls the `advisor` tool:

```json
{
  "question": "Should I extract billing into two services (invoicing, payment-processing) or keep it as one monolithic payments module?",
  "context": "Currently one `payments/` package handling invoice generation, charge processing, and webhook handling. Team is 3 engineers. No multi-region or independent-scaling requirement yet, but webhook volume is growing fast."
}
```

The plugin snapshots the recent transcript, runs the question past the
`advisor-strategist` child session, and returns the distilled answer as the
tool result — the executor's own context never sees the advisor's
intermediate file reads or research. A response follows a fixed shape
(recommendation, rationale, risks, next steps); abridged here for length:

```
1. Recommendation
Keep it one module for now; split invoicing out only once webhook volume
or team size forces it.

2. Rationale
A 3-engineer team gets more value from one deploy/test surface than from
service boundaries you don't have a scaling reason for yet. Webhook growth
is a signal to watch, not a reason to split today.

3. Risks / Watchpoints
Watch webhook handler latency and invoice-generation coupling — if either
starts blocking the other's deploys, that's the trigger to split.

4. Concrete Next Steps
- Add a latency/error-rate dashboard for the webhook handler specifically.
- Keep invoice generation and charge processing behind separate internal
  interfaces now, so a future extraction is a module move, not a rewrite.
```

Real advisor responses are not artificially compressed — the prompt asks for
whatever depth the question warrants, so expect fuller answers on harder
questions.

## Security guarantees

- **Read-only.** The advisor cannot edit files, run destructive shell
  commands, or call itself recursively.
- **Not local-only.** Enabling it means the question, optional context, and a
  bounded transcript snapshot can be sent to the configured
  `advisor-strategist` model provider, and inspected inside a separate
  opencode child session.
- **Hardened permission defaults.** The child session only gets read-only
  research tools (file read/list/glob/grep, skills, a narrow read-only `git`/
  shell allowlist); known credential-bearing paths (`.env*`, SSH/cloud
  credential files, etc.) are hard-denied, as are destructive/publication
  shell commands and shell chaining/redirection patterns operators cannot
  weaken.
- **Best-effort secret redaction**, applied to prompt material and advisor
  output. This is a safety net, not a data-loss-prevention guarantee — it
  will not catch every secret format or business-sensitive value.
- **Per-session call budget**, a cost/loop-control guard (not a privacy
  boundary) — see [Configuration](#configuration) below.
- Web fetch, web search, and MCP documentation tools are denied by default
  and only usable with explicit operator opt-in on a runtime that exposes
  them.

Full detail — the exact denylist, redaction regexes, child-session abort
handling, and other edge cases — lives in
[`docs/security-model.md`](docs/security-model.md).

## Configuration

### Advisor model — `OPENCODE_ADVISOR_MODEL`

The model used by the `advisor-strategist` agent is resolved from configuration rather than a hard-coded literal. Resolution precedence (highest first):

1. The `OPENCODE_ADVISOR_MODEL` environment variable (a combined `provider/model-id` string, for example `openai/gpt-5.5`).
2. A `model` set on the `advisor-strategist` agent in `opencode.json`.
3. opencode's configured default `model`.

If none resolve, the advisor falls back to the agent's / session default model. To pin the advisor model, set the env var before launching opencode:

```sh
export OPENCODE_ADVISOR_MODEL="openai/gpt-5.5"
```

Model identifiers must use the combined `provider/model-id` form. Malformed
values such as a bare model id or an empty provider/model component are ignored,
so the advisor falls back to the next valid configured model.

OpenAI advisor calls set the provider-specific `reasoningEffort` option to
`high`. Non-OpenAI providers use their provider/runtime reasoning defaults; this
package does not claim a provider-portable high-reasoning knob.

### Call budget — `MAX_CALLS_PER_SESSION`

Each consultation runs a separate high-reasoning model over up to ~90 KB of transcript and is the most expensive thing this plugin does, so consultations are capped per executor session by the `MAX_CALLS_PER_SESSION` constant (default `10`). Once the budget is spent, the tool returns a polite "continue without additional advisor consultation" notice instead of running.

This budget is a source-code constant, not an environment variable. To change it, edit `MAX_CALLS_PER_SESSION` in `advisor-core.js`; `advisor.js` imports the same helper and message formatting so the runtime and tests stay in sync.

## For AI agents

If you are an executor agent deciding whether to call `advisor`: it costs one
unit of a small per-session budget, runs read-only, and returns only distilled
text — no research artifacts leak into your context. Use it for non-obvious
design decisions, repeated failures, or before a broad/risky edit, not for
routine steps. The plugin's internal hook wiring is documented in
[`docs/internals.md`](docs/internals.md) if you need it.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE) for
the full license text.

## Compatibility and contributing

This package targets `@opencode-ai/plugin@^1.17.7` and Node.js 20.11.0+; Bun
is the contributor package manager. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the full toolchain, test commands, and dependency-license audit process,
and [`CHANGELOG.md`](CHANGELOG.md) for release notes.

## Support and reporting issues

File bugs and feature requests in the [GitHub issue tracker](https://github.com/mcrescenzo/opencode-advisor/issues). The package metadata (`bugs`, `homepage`, `repository`) points here as well, so the reporting surface is discoverable from npm. For private vulnerability reports, use the process in [`SECURITY.md`](SECURITY.md).

When reporting an advisor issue, please include:

- The `@mcrescenzo/opencode-advisor` version and your opencode version.
- The advisor model in effect: the value of `OPENCODE_ADVISOR_MODEL` if you set it, otherwise note that the configured default `model` or `advisor-strategist` agent `model` was used.
- Which surface is affected — the `advisor` tool itself (for example the per-session budget notice, tool registration, or permission behavior) versus the quality/content of the advice returned.
- The advisor tool result text, with any secrets, credentials, or private paths redacted.
- If the problem is permission-related, the advisor command or pattern you expected to be allowed/denied and what actually happened.

The advisor is read-only by design: it cannot edit files or run destructive shell commands. If you observe otherwise, that is a security-relevant report; please report it privately through [`SECURITY.md`](SECURITY.md).
