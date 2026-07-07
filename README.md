# advisor

`advisor` is an opencode plugin that provides an **`advisor` tool**: a budgeted, read-only child-session strategist for mid-task design guidance and risk review.

When an executor agent that has been explicitly allowed to use `advisor` reaches a non-obvious decision — a broad or risky edit, repeated failures, an unclear test/debugging strategy, an architecture tradeoff, a dependency/API question, or a final strategic review — it calls `advisor`. The plugin snapshots the executor's recent transcript, spins up a **child session** under a hidden, high-capability `advisor-strategist` agent, and returns only the distilled advice text. The advisor can inspect files and search code; network and MCP documentation tools are denied by default and require explicit operator opt-in. The advisor **cannot edit files or run destructive shell commands**, and the executor's context is never polluted with the advisor's intermediate research.

This README includes the public design, security, privacy, configuration, and
compatibility details needed to evaluate and use the published package.

## Registration

When installed from npm, register the plugin by package name in `opencode.json` under the singular `"plugin"` key:

```json
{
  "plugin": [
    "@mcrescenzo/opencode-advisor"
  ]
}
```

opencode loads plugins once at startup. After registering or changing the plugin, restart opencode — running sessions keep the already-loaded plugin set.

### Contributor checkout registration

For local development from a source checkout, register the plugin by a relative path from the config file to `advisor.js` instead of by package name:

```json
{
  "plugin": [
    "./plugins/advisor/advisor.js"
  ]
}
```

## Hooks

This plugin registers exactly four hooks:

| Hook | Behavior |
| --- | --- |
| `config` | Mutates the live config in place: resolves the advisor model (env override, then an existing `advisor-strategist` agent model, then the configured default model) and installs the hidden `advisor-strategist` agent with its locked-down permission set. |
| `tool` | Registers the single `advisor` tool (see [Tools](#tools) below): budgets calls per session, snapshots the parent transcript, spins up a child session under `advisor-strategist`, and returns the distilled advice text. |
| `chat.params` | For prompts sent to the `advisor-strategist` agent on an OpenAI provider only, sets the provider-specific `reasoningEffort` option to `high`. No-op for every other agent or provider. |
| `dispose` | No-op. The per-session call-budget counter is module-level and intentionally survives plugin factory disposal so one disposed instance cannot refund budget spent by another active instance. |

## Tools

- `advisor` — consult the `advisor-strategist` agent about a strategic question. Arguments:
  - `question` (required, max 4,000 characters): the specific design decision, risk, or failure mode to get advice on.
  - `context` (optional, max 12,000 characters): concise context about what has already been tried or what decision is pending.

Registering the plugin makes the `advisor` tool available, but it does not
grant every agent permission to call it. Opt in only the agents that should be
allowed to consult the higher-privileged advisor child session, for example:

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

The advisor's shell access is intentionally narrow and non-interactive. Common read-only inspection commands may run by default, while unknown commands and commands that execute project-controlled code — for example `node --test`, `npm test`, `npm run test`, or `bun test` — are denied unless a maintainer explicitly opts into specific broader permissions. Destructive and publication commands are hard-denied by the plugin defaults, as are absolute-path and parent-directory shell arguments.

## Security, privacy, and data flow

The advisor is **read-only**, not **local-only**. Enabling it means selected
conversation and workspace context can be sent to the configured
`advisor-strategist` model provider and can be inspected inside a separate
opencode child session.

### What data is collected and forwarded

For each advisor call, the plugin sends the child advisor session:

- the `question` argument supplied to the `advisor` tool;
- the optional `context` argument supplied to the tool;
- the current workspace directory/worktree metadata available to the tool
  context; and
- a bounded snapshot of recent parent-session messages. The snapshot excludes
  previous advisor-agent messages and synthetic `advisor-plugin` parts, keeps the
  most recent tail when it is too large, and is capped by the plugin's transcript
  limits.

The advisor may then use its read-only research tools in the child session. Any
file contents, search results, web pages, or documentation snippets it chooses to
inspect can become part of that child session's model context and local opencode
session history. The parent executor receives only the final text answer that the
advisor returns.

### Model-provider, web, and MCP exposure

Advisor prompts and any tool results used by the child advisor can be sent to the
model/provider selected for `advisor-strategist`. Skills are allowed by the
hardened defaults. Raw web search and web fetch tools stay denied even if an
operator tries to allow them directly, because this plugin does not enforce a URL
egress policy around those tools. Documentation/network access should use a
separate runtime-approved tool or wrapper with its own public-host allowlist and
SSRF protection. MCP documentation tools are denied by default and are usable
only when your opencode runtime exposes them and operator configuration
explicitly permits those tool names. Those tools have their own trust boundaries:
requests may leave your machine, remote services may receive query text or URLs,
and MCP servers may apply their own logging and retention policies.

Do not include secrets, credentials, private keys, unpublished vulnerability
details, or sensitive customer data in prompts, tool arguments, repository files,
or transcripts that the advisor may inspect unless your model/provider and tool
configuration are approved for that data.

### Permission boundary

The plugin installs a hidden `advisor-strategist` agent with a deliberately
locked-down permission set:

- **Allowed by default:** read-only local research tools such as file reads,
  listing, globbing, grepping, skills, and a narrow bash allowlist for inspection
  commands such as `pwd`, `ls`, and selected read-only `git` commands including
  `git ls-files`.
- **Credential paths denied by default:** known secret-bearing files and
  locations such as `.env*`, `**/.env*`, `*.pem`, `*.key`, `secrets.*`,
  `secrets/**`, `**/secrets/**`, `credentials.*`, `credentials/**`,
  `**/credentials/**`, `.beads-credential-key`, package-manager auth files such
  as `.npmrc`, `.yarnrc.yml`, `.pnpmrc`, and `.pypirc`, `.netrc`,
  `.git-credentials`, Docker and kube auth files such as
  `.docker/config.json`, `.kube/config`, and `kubeconfig*`, standalone SSH key
  names such as `id_rsa` and `id_ed25519`, certificate bundles such as `*.p12`
  and `*.pfx`, `.ssh/*`, `.aws/*`, `.azure/*`, `.config/gcloud/*`, and
  `.config/gh/hosts.yml` are denied for advisor `read`, `list`, `glob`, and
  `grep` access, and are hard-denied when referenced by bash commands.
- **Denied by default:** editing files, recursive advisor calls, destructive VCS
  actions, unknown tools and shell commands, commands that execute
  project-controlled code, file copy/move and recursive ownership/mode changes,
  deletion/cleanup commands, publication/release commands, shell
  search commands with arbitrary arguments such as `rg *` and `grep *`,
  path-bearing syntax checks such as `node --check *`, symlink-following search
  flags such as `rg --follow` and `grep -R`, shell
  chaining/input-or-output-redirection/command-substitution patterns, shell
  arguments that target absolute paths, home-directory expansion, environment
  variables, or parent-directory traversal, web search, web fetch, and
  representative destructive cloud/container commands.

The advisor is designed not to ask for permissions while running in the
background. Operator configuration can harden these permissions or explicitly
allow known non-protected tools and commands, but broad wildcard allows do not
widen the default advisor policy, `ask` is normalized away, and built-in
destructive/publication hard-denies cannot be weakened.

Advisor child permissions are independent of the calling executor's effective
permissions; they are not mirrored or capped per call. Because the child can read
and search ordinary workspace files under its own hardened policy, granting an
executor the `advisor` tool is an explicit trust decision for that executor.

### Child-session isolation and persistence

Advisor work runs in a child session whose `parentID` points at the executor
session. This keeps the advisor's intermediate research out of the executor's
main context window, but it does not make the research ephemeral: normal
opencode session storage, logs, provider retention, and MCP/tool retention rules
may still apply to the child session.

The child prompt disables the `advisor` tool and edit-family tools (`edit`,
`write`, `apply_patch`, and `patch`) for that run, so the advisor cannot
recursively call itself and cannot edit files through the prompt tool selection
even if prompt text asks it to.

If the executor aborts before the child prompt is sent, the plugin aborts any
known child session and rolls back the reserved advisor-call budget. If the
abort happens after prompt dispatch, the call is treated as spent: the plugin
asks opencode to abort the child session, waits briefly for the prompt request
to settle, then returns an aborted-consultation message. If the prompt does not
settle before that short cleanup window, the tool records best-effort metadata
for the timeout and returns; a provider request may still continue if the
runtime cannot cancel it.

### Redaction and limits

The plugin applies best-effort redaction for common credential-like strings in
advisor-visible prompt material and advisor-returned text. This is a safety net,
not a data-loss-prevention system. It will not recognize every secret format, may
miss sensitive business data that is not syntactically credential-like, and does
not guarantee removal from provider-side or tool-side logs once data has been
sent.

URL query redaction covers common signed URL and OAuth/OIDC credential keys,
including AWS and Google signature/credential parameters, `access_token`,
`refresh_token`, `id_token`, `client_secret`, `code`, `token`, `signature`,
`credential`, `secret`, key-style, and session-style parameters. It intentionally
leaves unrelated query values intact and remains best-effort.

Each executor session also has a fixed advisor call budget. Once the budget is
spent, the plugin returns a budget-reached message instead of creating another
advisor child session. The budget is a cost and loop-control guard; it is not a
privacy boundary.

See [`docs/dependency-license-inventory.md`](docs/dependency-license-inventory.md)
for the dependency license inventory and notice-risk record prepared for public
release. It is factual inventory only, not legal advice or approval.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE) for
the full license text.

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

## Compatibility and contributor toolchain

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

## Install and test

```sh
bun install
bun run test
```

`bun run test` runs the regression suite (`node --test tests/*.test.mjs`), covering pure helper logic, mocked plugin hook behavior, and package/export smoke checks. For a focused syntax-only gate, run:

```sh
bun run check
```

No live opencode runtime or model calls are required. The entry-hook tests are intentional because the permission and child-session isolation behavior lives at the plugin boundary.

## Support and reporting issues

File bugs and feature requests in the [GitHub issue tracker](https://github.com/mcrescenzo/opencode-advisor/issues). The package metadata (`bugs`, `homepage`, `repository`) points here as well, so the reporting surface is discoverable from npm. For private vulnerability reports, use the process in [`SECURITY.md`](SECURITY.md).

When reporting an advisor issue, please include:

- The `@mcrescenzo/opencode-advisor` version and your opencode version.
- The advisor model in effect: the value of `OPENCODE_ADVISOR_MODEL` if you set it, otherwise note that the configured default `model` or `advisor-strategist` agent `model` was used.
- Which surface is affected — the `advisor` tool itself (for example the per-session budget notice, tool registration, or permission behavior) versus the quality/content of the advice returned.
- The advisor tool result text, with any secrets, credentials, or private paths redacted.
- If the problem is permission-related, the advisor command or pattern you expected to be allowed/denied and what actually happened.

The advisor is read-only by design: it cannot edit files or run destructive shell commands. If you observe otherwise, that is a security-relevant report; please report it privately through [`SECURITY.md`](SECURITY.md).
