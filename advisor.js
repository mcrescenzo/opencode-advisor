import { tool } from "@opencode-ai/plugin";
import {
  ADVISOR_AGENT,
  buildTranscript,
  advisorPrompt,
  splitModel,
  textPart,
  responseText,
  errorText,
  partTypes,
  createBoundedCounter,
  MAX_CALLS_PER_SESSION,
  MAX_QUESTION_CHARS,
  MAX_CONTEXT_CHARS,
  CONTINUE_WITHOUT_ADVISOR_GUIDANCE,
  consumeCallBudget,
  restoreCallBudget,
  validateAdvisorArgs,
  redactSecrets,
} from "./advisor-core.js";

const ADVISOR_MODEL_ENV = "OPENCODE_ADVISOR_MODEL";
const MESSAGE_LIMIT = 80;
const ADVISOR_REASONING_EFFORT = "high";
const ADVISOR_ABORTED_MESSAGE = `Advisor consultation was aborted. ${CONTINUE_WITHOUT_ADVISOR_GUIDANCE}`;
const ABORT_PROMPT_DRAIN_TIMEOUT_MS = 50;
const EDIT_TOOL_NAMES = Object.freeze(["edit", "write", "apply_patch", "patch"]);
const EDIT_TOOL_DENIES = Object.freeze(Object.fromEntries(
  EDIT_TOOL_NAMES.map((toolName) => [toolName, "deny"]),
));
const EDIT_TOOL_DISABLED = Object.freeze(Object.fromEntries(
  EDIT_TOOL_NAMES.map((toolName) => [toolName, false]),
));
const FILESYSTEM_RESEARCH_TOOLS = Object.freeze(["read", "list", "glob", "grep"]);
const CREDENTIAL_PATH_PATTERNS = [
  ".env",
  ".env*",
  "**/.env",
  "**/.env*",
  "*.pem",
  "**/*.pem",
  "*.key",
  "**/*.key",
  "secrets",
  "secrets.*",
  "secrets/**",
  "**/secrets",
  "**/secrets.*",
  "**/secrets/**",
  "credentials",
  "credentials.*",
  "credentials/**",
  "**/credentials",
  "**/credentials.*",
  "**/credentials/**",
  ".beads-credential-key",
  "**/.beads-credential-key",
  ".npmrc",
  "**/.npmrc",
  "~/.npmrc",
  ".yarnrc",
  "**/.yarnrc",
  "~/.yarnrc",
  ".yarnrc.yml",
  "**/.yarnrc.yml",
  "~/.yarnrc.yml",
  ".pnpmrc",
  "**/.pnpmrc",
  "~/.pnpmrc",
  ".pypirc",
  "**/.pypirc",
  "~/.pypirc",
  ".netrc",
  "**/.netrc",
  "~/.netrc",
  ".git-credentials",
  "**/.git-credentials",
  "~/.git-credentials",
  ".docker/config.json",
  "**/.docker/config.json",
  "~/.docker/config.json",
  ".kube/config",
  "**/.kube/config",
  "~/.kube/config",
  "kubeconfig",
  "kubeconfig.*",
  "**/kubeconfig",
  "**/kubeconfig.*",
  "id_rsa",
  "**/id_rsa",
  "id_ed25519",
  "**/id_ed25519",
  "*.p12",
  "**/*.p12",
  "*.pfx",
  "**/*.pfx",
  ".ssh/*",
  "**/.ssh/*",
  "~/.ssh/*",
  ".aws/*",
  "**/.aws/*",
  "~/.aws/*",
  ".azure/*",
  "**/.azure/*",
  "~/.azure/*",
  ".config/gcloud/*",
  "**/.config/gcloud/*",
  "~/.config/gcloud/*",
  ".config/gh/hosts.yml",
  "**/.config/gh/hosts.yml",
  "~/.config/gh/hosts.yml",
];
const BASH_CREDENTIAL_PATH_MARKERS = [
  ".env",
  ".pem",
  ".key",
  "secrets",
  "secrets.",
  "credentials",
  ".beads-credential-key",
  ".npmrc",
  ".yarnrc",
  ".pnpmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".docker/config.json",
  ".kube/config",
  "kubeconfig",
  "id_rsa",
  "id_ed25519",
  ".p12",
  ".pfx",
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh/hosts.yml",
];
const READ_ONLY_BASH_ALLOWLIST = Object.freeze([
  { command: "pwd", allowArgs: true },
  { command: "ls", allowArgs: true },
  { command: "rg" },
  { command: "grep" },
  { command: "git status", allowArgs: true },
  { command: "git diff", allowArgs: true },
  { command: "git log", allowArgs: true },
  { command: "git show", allowArgs: true },
  { command: "git branch" },
  { command: "git branch --show-current" },
  { command: "git branch --list", allowArgs: true },
  { command: "git rev-parse", allowArgs: true },
  { command: "git ls-files", allowArgs: true },
]);

// Per-session advisor call-counts, keyed by sessionID. Bounded so it cannot
// accumulate one entry per session for the whole opencode process lifetime
// (see createBoundedCounter). This must remain module-scoped because OpenCode
// can instantiate the plugin factory more than once in one process.
const callCounts = createBoundedCounter();

// Resolve the advisor agent's model from configuration rather than a literal.
// Precedence: explicit env override, a user-set advisor agent model already in
// the opencode config, then opencode's configured default model.
function resolveAdvisorModel(cfg) {
  const candidates = [
    process.env[ADVISOR_MODEL_ENV],
    cfg?.agent?.[ADVISOR_AGENT]?.model,
    cfg?.model,
  ];

  for (const candidate of candidates) {
    const model = nonEmptyString(candidate);
    if (model && splitModel(model)) return model;
  }

  return undefined;
}

function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function providerID(value) {
  if (typeof value === "string") return nonEmptyString(value);
  if (!isPlainObject(value)) return undefined;
  for (const candidate of [
    value.id,
    value.providerID,
    value.providerId,
    value.info?.id,
    value.info?.providerID,
    value.info?.providerId,
    value.model?.providerID,
    value.model?.providerId,
  ]) {
    const provider = nonEmptyString(candidate);
    if (provider) return provider;
  }
  return undefined;
}

function modelProviderID(value) {
  const combinedModel = nonEmptyString(value);
  if (combinedModel) return splitModel(combinedModel)?.providerID;
  if (!isPlainObject(value)) return undefined;

  for (const candidate of [
    value.providerID,
    value.providerId,
    value.info?.providerID,
    value.info?.providerId,
  ]) {
    const provider = nonEmptyString(candidate);
    if (provider) return provider;
  }
  return undefined;
}

function advisorProviderID(input) {
  return providerID(input?.provider) ??
    providerID(input?.providerID) ??
    providerID(input?.providerId) ??
    modelProviderID(input?.model);
}

function applyAdvisorReasoning(input, output) {
  const provider = advisorProviderID(input);
  if (provider !== "openai") return;

  const existingOptions = output.options ?? {};
  const existingProviderOptions = existingOptions.providerOptions ?? {};
  const existingOpenAI = existingProviderOptions.openai ?? {};

  output.options = {
    ...existingOptions,
    providerOptions: {
      ...existingProviderOptions,
      openai: {
        ...existingOpenAI,
        reasoningEffort: ADVISOR_REASONING_EFFORT,
      },
    },
  };
}

function readOnlyBashAllowEntries() {
  return READ_ONLY_BASH_ALLOWLIST.flatMap(({ command, allowArgs }) => (
    allowArgs
      ? [[command, "allow"], [`${command} *`, "allow"]]
      : [[command, "allow"]]
  ));
}

function advisorBashPermission() {
  return {
    "*": "deny",

    // Common read-only inspection and validation commands used by advisor
    // research. Keep these specific; do not replace them with `git *` or a
    // broad package-manager allow.
    ...Object.fromEntries(readOnlyBashAllowEntries()),

    // Shell search and path-bearing syntax checks cannot apply the advisor's
    // filesystem-tool path denies or prove realpath/symlink containment from a
    // command string. Prefer the read/list/glob/grep tools for code research.
    "rg *": "deny",
    "grep *": "deny",
    "node --check *": "deny",
    "rg --follow*": "deny",
    "rg *--follow*": "deny",
    "rg -L*": "deny",
    "rg * -L*": "deny",
    "grep -R*": "deny",
    "grep * -R*": "deny",
    "grep --dereference-recursive*": "deny",
    "grep * --dereference-recursive*": "deny",

    // Representative destructive or publication commands are hard-denied even
    // though the default for unknown commands is already deny.
    "git push*": "deny",
    "git reset --hard*": "deny",
    "git checkout --*": "deny",
    "git switch -f*": "deny",
    "git switch --force*": "deny",
    "git branch -d*": "deny",
    "git branch -D*": "deny",
    "git branch -m*": "deny",
    "git branch -M*": "deny",
    "git branch -c*": "deny",
    "git branch -C*": "deny",
    "git branch --delete*": "deny",
    "git branch --move*": "deny",
    "git branch --copy*": "deny",
    "git branch --force*": "deny",
    "git diff *--output*": "deny",
    "git diff *--ext-diff*": "deny",
    "git diff *--textconv*": "deny",
    "git log *--output*": "deny",
    "git log *--ext-diff*": "deny",
    "git log *--textconv*": "deny",
    "git show *--output*": "deny",
    "git show *--ext-diff*": "deny",
    "git show *--textconv*": "deny",
    "git restore *": "deny",
    "git clean*": "deny",
    "rm *": "deny",
    "mv *": "deny",
    "cp *": "deny",
    "sudo *": "deny",
    "chmod -R *": "deny",
    "chown -R *": "deny",
    "docker system prune*": "deny",
    "kubectl delete*": "deny",
    "helm uninstall*": "deny",
    "aws * delete*": "deny",
    "gcloud * delete*": "deny",
    "npm publish*": "deny",
    "pnpm publish*": "deny",
    "yarn publish*": "deny",
    "bun publish*": "deny",
    "gh release*": "deny",

    // Credential-bearing paths must stay hard-denied for shell research too;
    // otherwise read-only shell commands such as `git show *` could bypass the
    // filesystem-tool credential denies above.
    ...advisorBashCredentialPathDenies(),

    // Chaining, pipes, redirection, and command substitution can turn an
    // otherwise read-only prefix into a mutating or exfiltrating shell program.
    "*;*": "deny",
    "*&&*": "deny",
    "*||*": "deny",
    "*|*": "deny",
    "*>*": "deny",
    "*<*": "deny",
    "*`*": "deny",
    "* $*": "deny",
    "*=$*": "deny",
    "*$(*": "deny",
    "*\n*": "deny",
    "* /*": "deny",
    "*=/*": "deny",
    "* ~*": "deny",
    "*=~*": "deny",
    "* ..": "deny",
    "* ../*": "deny",
    "*../*": "deny",
  };
}

function advisorBashCredentialPathDenies() {
  return Object.fromEntries(
    BASH_CREDENTIAL_PATH_MARKERS.map((marker) => [`*${marker}*`, "deny"]),
  );
}

function advisorFilesystemPermission() {
  return Object.fromEntries([
    ["*", "allow"],
    ...CREDENTIAL_PATH_PATTERNS.map((pattern) => [pattern, "deny"]),
  ]);
}

function defaultAdvisorPermission() {
  return {
    "*": "deny",
    ...Object.fromEntries(
      FILESYSTEM_RESEARCH_TOOLS.map((toolName) => [toolName, advisorFilesystemPermission()]),
    ),
    webfetch: "deny",
    websearch: "deny",
    skill: "allow",
    bash: advisorBashPermission(),
    advisor: "deny",
    ...EDIT_TOOL_DENIES,
  };
}

const ACTION_RANK = { allow: 0, ask: 1, deny: 2 };

function isAction(value) {
  return Object.hasOwn(ACTION_RANK, value);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const PROTECTED_PERMISSION_KEYS = [
  "advisor",
  "bash",
  ...EDIT_TOOL_NAMES,
];

function globMatches(pattern, value) {
  if (pattern === value) return true;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

function matchesProtectedPermissionKey(key) {
  return PROTECTED_PERMISSION_KEYS.some((protectedKey) => globMatches(key, protectedKey));
}

function normalizeAdvisorAction(value) {
  return value === "ask" ? "deny" : value;
}

function stricterAction(defaultAction, operatorAction) {
  const normalizedOperator = normalizeAdvisorAction(operatorAction);
  if (!isAction(normalizedOperator)) return defaultAction;
  if (!isAction(defaultAction)) return normalizedOperator;
  return ACTION_RANK[normalizedOperator] > ACTION_RANK[defaultAction]
    ? normalizedOperator
    : defaultAction;
}

function mergePermissionValue(defaultValue, operatorValue, options = {}) {
  if (operatorValue === undefined) return defaultValue;
  const normalizedOperator = isAction(operatorValue)
    ? normalizeAdvisorAction(operatorValue)
    : operatorValue;

  if (isAction(defaultValue) && isAction(normalizedOperator)) {
    if (normalizedOperator === "allow" && defaultValue === "deny") {
      return options.allowDenyOverride ? "allow" : defaultValue;
    }
    return stricterAction(defaultValue, normalizedOperator);
  }

  if (isPlainObject(defaultValue) && isPlainObject(normalizedOperator)) {
    return mergePermissionObject(defaultValue, normalizedOperator, options);
  }

  if (isPlainObject(defaultValue) && isAction(normalizedOperator)) {
    if (normalizedOperator === "allow") return defaultValue;
    return normalizedOperator;
  }

  if (isAction(defaultValue) && isPlainObject(normalizedOperator)) {
    if (defaultValue === "deny" && !options.allowDenyOverride) return "deny";
    return mergePermissionObject({ "*": defaultValue }, normalizedOperator, options);
  }

  return defaultValue;
}

function mergePermissionObject(defaults, operator = {}, options = {}) {
  const merged = {};
  const operatorWildcard = isAction(operator["*"])
    ? normalizeAdvisorAction(operator["*"])
    : undefined;

  for (const [key, defaultValue] of Object.entries(defaults)) {
    let value = defaultValue;
    if (key !== "*" && operatorWildcard !== undefined && operatorWildcard !== "allow") {
      value = mergePermissionValue(value, operatorWildcard, options);
    }
    if (Object.hasOwn(operator, key)) {
      value = mergePermissionValue(value, operator[key], {
        ...options,
        allowDenyOverride: options.optInKeys?.has(key) === true,
      });
    }
    merged[key] = value;
  }

  for (const [key, operatorValue] of Object.entries(operator)) {
    if (Object.hasOwn(merged, key)) continue;
    const normalizedOperator = isAction(operatorValue)
      ? normalizeAdvisorAction(operatorValue)
      : operatorValue;
    if (matchesProtectedPermissionKey(key)) {
      if (operatorValue === "deny") merged[key] = "deny";
      continue;
    }
    if (isPlainObject(normalizedOperator)) {
      const nested = mergePermissionObject({}, normalizedOperator, options);
      if (Object.keys(nested).length) merged[key] = nested;
    } else if (isAction(normalizedOperator)) {
      if (normalizedOperator === "allow" && options.allowUnknownAllows !== false) {
        merged[key] = "allow";
      } else if (normalizedOperator === "deny") {
        merged[key] = "deny";
      }
    }
  }

  return merged;
}

function enforceAdvisorBashHardDenies(bashPermission) {
  if (!isPlainObject(bashPermission)) return bashPermission;

  // OpenCode permission objects are order-sensitive: the last matching pattern
  // wins. Operator config may add stricter denies, but it must not weaken the
  // advisor's built-in destructive/publication hard-denies with later, more
  // specific operator rules such as { "rm -rf *": "allow" }. Re-append built-in denies
  // after the operator merge so they retain final precedence.
  for (const [pattern, action] of Object.entries(advisorBashPermission())) {
    if (pattern === "*" || action !== "deny") continue;
    delete bashPermission[pattern];
    bashPermission[pattern] = "deny";
  }

  return bashPermission;
}

function enforceAdvisorFilesystemHardDenies(filesystemPermission) {
  if (!isPlainObject(filesystemPermission)) return filesystemPermission;

  // OpenCode permission objects are order-sensitive. Operator config may add
  // more-specific filesystem allows, but credential-path denies must retain
  // final precedence for all read/search filesystem tools.
  for (const pattern of CREDENTIAL_PATH_PATTERNS) {
    delete filesystemPermission[pattern];
    filesystemPermission[pattern] = "deny";
  }

  return filesystemPermission;
}

function mergeAdvisorPermission(existingPermission) {
  const operatorPermission = isAction(existingPermission)
    ? { "*": existingPermission }
    : isPlainObject(existingPermission)
      ? existingPermission
      : {};
  const permission = mergePermissionObject(
    defaultAdvisorPermission(),
    operatorPermission,
    {
      allowUnknownAllows: true,
    },
  );

  // Non-negotiable advisor invariants. Operators may opt into non-protected
  // tools, but the advisor must remain read-only and non-recursive.
  for (const toolName of EDIT_TOOL_NAMES) {
    permission[toolName] = "deny";
  }
  permission.advisor = "deny";
  for (const toolName of ["read", "list", "glob", "grep"]) {
    permission[toolName] = enforceAdvisorFilesystemHardDenies(permission[toolName]);
  }
  const shouldResetBashPermission =
    permission.bash === "allow" ||
    (!isPlainObject(permission.bash) && !isAction(permission.bash)) ||
    (isPlainObject(permission.bash) && permission.bash["*"] === "allow");
  if (shouldResetBashPermission) {
    permission.bash = mergePermissionObject(advisorBashPermission(), {});
  }
  permission.bash = enforceAdvisorBashHardDenies(permission.bash);

  return permission;
}

function advisorAgentConfig(existing, resolvedAdvisorModel) {
  const existingAgent = isPlainObject(existing) ? existing : {};
  return {
    ...existingAgent,
    description:
      existingAgent.description ??
      "Hidden high-capability advisor for strategic guidance, codebase/doc research, and risk checks. Uses broad research tools but cannot edit files or run destructive shell commands.",
    mode: "primary",
    hidden: true,
    model: resolvedAdvisorModel,
    temperature: 0.1,
    steps: 12,
    permission: mergeAdvisorPermission(existingAgent.permission),
  };
}

function advisorSessionShape(ctx) {
  return ctx.__advisorSessionShape ??
    ctx.client?.__advisorSessionShape ??
    ctx.__workflowSessionShape ??
    ctx.client?.__workflowSessionShape ??
    "v1";
}

function advisorSessionApi(ctx) {
  const session = ctx.client?.session ?? {};
  const useV2 = advisorSessionShape(ctx) === "v2";

  return {
    messages(input) {
      return useV2
        ? session.messages({
            sessionID: input.sessionID,
            directory: input.directory,
            limit: input.limit,
          })
        : session.messages({
            path: { id: input.sessionID },
            query: { directory: input.directory, limit: input.limit },
          });
    },
    create(input) {
      return useV2
        ? session.create({
            directory: input.directory,
            parentID: input.parentID,
            title: input.title,
          })
        : session.create({
            body: {
              parentID: input.parentID,
              title: input.title,
            },
            query: { directory: input.directory },
          });
    },
    prompt(input) {
      return useV2
        ? session.prompt({
            sessionID: input.sessionID,
            directory: input.directory,
            ...input.body,
          })
        : session.prompt({
            path: { id: input.sessionID },
            query: { directory: input.directory },
            body: input.body,
          });
    },
    abort(input) {
      if (typeof session.abort !== "function") return undefined;
      return useV2
        ? session.abort({ sessionID: input.sessionID, directory: input.directory })
        : session.abort({ path: { id: input.sessionID }, query: { directory: input.directory } });
    },
  };
}

function continueWithoutAdvisorGuidance(message) {
  return `${message}. ${CONTINUE_WITHOUT_ADVISOR_GUIDANCE}`;
}

function consultationFailure(message, error) {
  const details = errorText(error);
  const text = details ? `${message}: ${details}` : message;
  return continueWithoutAdvisorGuidance(redactSecrets(text));
}

function reportMetadata(toolContext, input) {
  if (typeof toolContext?.metadata !== "function") return;
  try {
    Promise.resolve(toolContext.metadata(input)).catch(() => {});
  } catch {
    // Non-critical executor UI metadata must not affect advisor execution.
  }
}

export default async (ctx) => {
  // Resolved from this factory instance's config hook argument (or a user
  // override) so one plugin instance cannot overwrite another instance's child
  // prompt model selection. Undefined means opencode falls back to the agent's /
  // session default model.
  let resolvedAdvisorModel;

  return {
  config: async (cfg) => {
    cfg.agent = cfg.agent ?? {};

    // Read the advisor model from config (before we overwrite the agent entry),
    // so a user-supplied model is honored rather than a hard-coded literal.
    resolvedAdvisorModel = resolveAdvisorModel(cfg);

    cfg.agent[ADVISOR_AGENT] = advisorAgentConfig(
      cfg.agent[ADVISOR_AGENT],
      resolvedAdvisorModel,
    );
  },

  tool: {
    advisor: tool({
      description:
        "Automatically consult a high-capability advisor for non-obvious design decisions, broad or risky edits, repeated failures, unclear test/debugging strategy, architecture tradeoffs, dependency/API questions, or final strategic review. The advisor may inspect files, search code, use explicitly permitted network or MCP documentation tools, and run non-destructive commands, but it cannot edit files or run destructive shell commands. Use proactively when better strategy could prevent wasted work.",
      args: {
        question: tool.schema
          .string()
          .min(1)
          .max(MAX_QUESTION_CHARS)
          .describe("The specific strategic question, risk, design decision, or failure mode to get advice on."),
        context: tool.schema
          .string()
          .max(MAX_CONTEXT_CHARS)
          .optional()
          .describe("Optional concise context about what has already been tried or what decision is pending."),
      },
      async execute(args, toolContext) {
        const argValidation = validateAdvisorArgs(args);
        if (!argValidation.ok) return argValidation.message;
        const sessionID = nonEmptyString(toolContext?.sessionID);
        if (!sessionID) {
          return continueWithoutAdvisorGuidance("Advisor could not identify the current session");
        }

        const previousCalls = callCounts.get(sessionID);
        const budget = consumeCallBudget(
          callCounts,
          sessionID,
          MAX_CALLS_PER_SESSION,
        );
        if (!budget.allowed) return budget.message;

        const rollbackBudget = () => {
          restoreCallBudget(callCounts, sessionID, previousCalls);
        };

        let result;
        let promptSent = false;
        let removeAbortListener;
        let abortCreatedChild = async () => {};
        try {
          const session = advisorSessionApi(ctx);
          let childSessionID;
          let abortStarted = false;
          let resolveAbort;
          const abortPromise = new Promise((resolve) => {
            resolveAbort = resolve;
          });
          const parentAborted = () => toolContext.abort?.aborted === true;
          const abortChild = async () => {
            if (!childSessionID) return;
            try {
              await session.abort({
                sessionID: childSessionID,
                directory: toolContext.directory,
              });
            } catch {
              // Best effort only: the parent abort still takes precedence.
            }
          };
          abortCreatedChild = abortChild;
          const beginAbort = () => {
            if (abortStarted) return;
            abortStarted = true;
            void abortChild();
            resolveAbort(ADVISOR_ABORTED_MESSAGE);
          };
          const stopIfAborted = () => {
            if (!parentAborted() && !abortStarted) return false;
            beginAbort();
            rollbackBudget();
            return true;
          };
          const raceWithAbort = async (operation) => {
            const operationPromise = Promise.resolve(operation);
            operationPromise.catch(() => {});
            if (parentAborted()) beginAbort();
            if (abortStarted) return ADVISOR_ABORTED_MESSAGE;
            return await Promise.race([operationPromise, abortPromise]);
          };
          const drainPromptAfterAbort = async (operation) => {
            const observed = Promise.resolve(operation).then(
              () => true,
              () => true,
            );
            const timedOut = Symbol("timed-out");
            let timeoutID;
            const outcome = await Promise.race([
              observed,
              new Promise((resolve) => {
                timeoutID = setTimeout(() => resolve(timedOut), ABORT_PROMPT_DRAIN_TIMEOUT_MS);
              }),
            ]);
            if (outcome !== timedOut) clearTimeout(timeoutID);
            if (outcome !== timedOut) return;
            reportMetadata(toolContext, {
              title: "Advisor abort cleanup timed out",
              metadata: { advisorAbortCleanupTimedOut: true },
            });
          };

          const onAbort = () => {
            beginAbort();
          };
          if (typeof toolContext.abort?.addEventListener === "function") {
            toolContext.abort.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => {
              if (typeof toolContext.abort?.removeEventListener === "function") {
                toolContext.abort.removeEventListener("abort", onAbort);
              }
            };
          }

          if (stopIfAborted()) return ADVISOR_ABORTED_MESSAGE;

          const messagesResult = await raceWithAbort(session.messages({
            sessionID,
            directory: toolContext.directory,
            limit: MESSAGE_LIMIT,
          }));

          if (messagesResult === ADVISOR_ABORTED_MESSAGE) {
            rollbackBudget();
            return ADVISOR_ABORTED_MESSAGE;
          }

          if (stopIfAborted()) return ADVISOR_ABORTED_MESSAGE;

          if (!isPlainObject(messagesResult) || messagesResult.error) {
            rollbackBudget();
            return continueWithoutAdvisorGuidance("Advisor could not read the current session transcript");
          }
          const parentMessages = Array.isArray(messagesResult.data) ? messagesResult.data : [];

          const childPromise = Promise.resolve(session.create({
            parentID: sessionID,
            title: "Advisor consultation",
            directory: toolContext.directory,
          }));
          childPromise.then(
            (child) => {
              if (!abortStarted || childSessionID || !isPlainObject(child) || !child.data?.id) return;
              childSessionID = child.data.id;
              void abortChild();
            },
            () => {},
          );
          const child = await raceWithAbort(childPromise);

          if (child === ADVISOR_ABORTED_MESSAGE) {
            rollbackBudget();
            return ADVISOR_ABORTED_MESSAGE;
          }

          if (!isPlainObject(child) || child.error || !child.data?.id) {
            rollbackBudget();
            return continueWithoutAdvisorGuidance("Advisor could not create a consultation session");
          }
          childSessionID = child.data.id;

          if (stopIfAborted()) return ADVISOR_ABORTED_MESSAGE;

          reportMetadata(toolContext, {
            title: `Advisor ${budget.count}/${MAX_CALLS_PER_SESSION}`,
            metadata: { advisorCalls: budget.count, maxAdvisorCalls: MAX_CALLS_PER_SESSION },
          });

          if (stopIfAborted()) return ADVISOR_ABORTED_MESSAGE;

          const childModel = splitModel(resolvedAdvisorModel);
          const promptText = advisorPrompt(args, buildTranscript(parentMessages), toolContext);
          const promptBody = {
            agent: ADVISOR_AGENT,
            ...(childModel ? { model: childModel } : {}),
            tools: { advisor: false, ...EDIT_TOOL_DISABLED },
            parts: [
              textPart(promptText, {
                metadata: { kind: "consultation" },
              }),
            ],
          };

          if (stopIfAborted()) return ADVISOR_ABORTED_MESSAGE;

          const promptCall = session.prompt({
            sessionID: childSessionID,
            directory: toolContext.directory,
            body: promptBody,
          });
          promptSent = true;
          const promptPromise = Promise.resolve(promptCall);
          const guardedPrompt = promptPromise.catch((error) => {
            if (parentAborted() || abortStarted) return ADVISOR_ABORTED_MESSAGE;
            throw error;
          });
          guardedPrompt.catch(() => {});

          result = await raceWithAbort(guardedPrompt);
          if (result === ADVISOR_ABORTED_MESSAGE) {
            beginAbort();
            await drainPromptAfterAbort(guardedPrompt);
          }
        } catch (error) {
          if (!promptSent) {
            rollbackBudget();
            await abortCreatedChild();
          }
          if (toolContext.abort?.aborted === true) return ADVISOR_ABORTED_MESSAGE;
          return consultationFailure("Advisor consultation failed", error);
        } finally {
          if (typeof removeAbortListener === "function") {
            try {
              removeAbortListener();
            } catch {
              // Listener cleanup is best-effort; do not mask advisor output.
            }
          }
        }

        if (result === ADVISOR_ABORTED_MESSAGE) return result;
        if (toolContext.abort?.aborted === true) return ADVISOR_ABORTED_MESSAGE;

        if (!isPlainObject(result)) {
          return consultationFailure("Advisor consultation failed", { message: "prompt returned no result" });
        }

        if (result.error) {
          return consultationFailure("Advisor consultation failed", result.error);
        }

        const assistantError = errorText(result.data?.info?.error);
        if (assistantError) {
          return continueWithoutAdvisorGuidance(redactSecrets(`Advisor consultation failed: ${assistantError}`));
        }

        const advice = responseText(result);
        if (advice) return redactSecrets(advice);

        const finish = result.data?.info?.finish;
        const details = [
          `parts: ${partTypes(result.data?.parts)}`,
          finish ? `finish: ${finish}` : undefined,
        ]
          .filter(Boolean)
          .join("; ");
        return continueWithoutAdvisorGuidance(`Advisor returned no text (${details})`);
      },
    }),
  },

  "chat.params": async (input, output) => {
    if (input.agent !== ADVISOR_AGENT) return;
    applyAdvisorReasoning(input, output);
  },

  // Best-effort cleanup on plugin teardown. The hard bound in callCounts is the
  // real guarantee against unbounded accumulation. Do not clear it here: this
  // module-level counter is shared across plugin factory instances, so disposing
  // one instance must not refund budgets used by another active instance.
  dispose: async () => {},
  };
};
