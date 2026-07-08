# Security model

Full detail behind the README's "Security guarantees" summary: what data the
`advisor` tool collects and forwards, exactly which tools/paths/commands are
allowed or denied for the hidden `advisor-strategist` child session, how
child-session isolation and abort handling work, and the limits of the
plugin's best-effort secret redaction.

## What data is collected and forwarded

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

## Model-provider, web, and MCP exposure

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

## Permission boundary

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

## Child-session isolation and persistence

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

## Redaction and limits

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

See [`dependency-license-inventory.md`](dependency-license-inventory.md)
for the dependency license inventory and notice-risk record prepared for public
release. It is factual inventory only, not legal advice or approval.
