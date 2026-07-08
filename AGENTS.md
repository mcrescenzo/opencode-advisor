# Advisor Plugin — Agent Notes

**Contract version:** `@opencode-ai/plugin@1.17.7` (declared range: `^1.17.7`)
**Verified against runtime:** opencode 1.17.7 (contract-level verification; see tests)

`advisor.js` is a single opencode plugin ES module that wires four hooks
(`config`, `tool`, `chat.params`, and a no-op `dispose`). Read this file
before touching it: it is the design rationale and the non-negotiable
invariants, not just operational trivia.

## Why this plugin exists

Executor agents are tuned to *do work*, not to stop and second-guess a risky
plan, research an unfamiliar API, or weigh an architecture tradeoff. The
advisor supplies that missing strategic layer on demand: a hidden **primary**
agent `advisor-strategist` (high-reasoning model resolved from
`OPENCODE_ADVISOR_MODEL`, then an existing `advisor-strategist` config, then
opencode's default `model`), plus an **`advisor` tool** the executor calls
mid-task to consult it. The `config` hook registers the tool but does not
auto-allow it for every agent — operators must explicitly grant `advisor`
permission per executor agent, keeping access an explicit trust decision.

## Design rationale

### Why a child session (not an inline call)

The `advisor` tool does **not** answer inside the executor's conversation. It
snapshots the executor's recent transcript, creates a **child session**
(`session.create` with `parentID = toolContext.sessionID`), prompts
`advisor-strategist` inside that child, and returns only the final advice
text. This gives: **context isolation** (the advisor's own research stays in
the child session; the executor gets only the distilled recommendation); a
**curated, bounded transcript** (`buildTranscript` excludes the advisor's own
messages and synthetic `advisor-plugin` parts, capped at `MESSAGE_LIMIT`
messages / `TRANSCRIPT_CHAR_LIMIT` chars, keeping the most recent tail); and
**separation of authority** (the child runs under the locked-down
`advisor-strategist` permission set, not mirrored or capped from the caller).

### Why a per-session call budget

`MAX_CALLS_PER_SESSION` (see `advisor-core.js`) is tracked in the
module-level `callCounts` map keyed by session ID — required at module scope
(not factory-closure scope) because opencode can double-instantiate plugin
factories. Each consultation spins up a separate high-reasoning model run
over a large transcript, the single most expensive thing this plugin can do,
so the budget caps an eager or looping executor per session. The counter is
bounded, but exhausted sessions are remembered separately so LRU churn cannot
silently refund a spent session.

## Invariants — an agent editing this plugin MUST NOT

1. **Never grant `advisor-strategist` edit/file-mutating tools.** Enforced
   three ways that must stay in agreement: denied edit-family permissions
   (`edit`, `write`, `apply_patch`, `patch`), the child prompt's disabled
   edit-family tools, and the prompt instruction not to edit files.
2. **Never grant the advisor broad tool or shell allowance.** Default is
   `"*": "deny"` with allows only for read-only research (`read`, `list`,
   `glob`, `grep`, skills) plus a narrow read-only bash allowlist.
   Credential-bearing paths and destructive/publication/chaining shell
   patterns stay hard-denied — see `docs/security-model.md` for the full
   pattern lists and keep both in sync if you change either.
3. **Never enable the `advisor` tool inside the advisor child session.** The
   child prompt sets `tools: { advisor: false }` to prevent recursive
   consultation.
4. **Never bypass or weaken the per-session budget.** Do not reset
   `callCounts` on every call, key it by anything other than the stable
   `sessionID`, or move it into factory-closure scope.
5. **Never feed advisor output back in as executor evidence.** The transcript
   builder filters out advisor-agent messages and `advisor-plugin` parts so
   the advisor never grades its own homework.

## Operational notes

- Keep code, tests, docs, and package metadata changes scoped to this
  directory.
- Syntax check: `npm run check`. Tests: `npm test` (`node --test
  tests/*.test.mjs`). `advisor-plugin.test.mjs` mocks the plugin entry hooks
  because permission/child-session wiring live at that boundary; helper logic
  is covered in `advisor-core.test.mjs`.
- opencode loads plugins once at startup; after changing `advisor.js` or
  `advisor-core.js`, restart opencode before expecting behavior changes.
- Generated local runtime state, dependency installs, diagnostics, and logs
  are intentionally ignored; do not add them to commits or package contents.
