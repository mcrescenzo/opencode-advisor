import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import advisorPlugin from "../advisor.js";
import {
  ADVISOR_AGENT,
  MAX_CALLS_PER_SESSION,
  MAX_QUESTION_CHARS,
  MAX_CONTEXT_CHARS,
} from "../advisor-core.js";

let sessionSerial = 0;

function nextSession(prefix = "session") {
  sessionSerial += 1;
  return `${prefix}-${sessionSerial}`;
}

function makeAbortSignalStub(options = {}) {
  return {
    aborted: false,
    added: [],
    removed: [],
    addEventListener(type, listener, listenerOptions) {
      this.added.push({ type, listener, options: listenerOptions });
      if (options.abortOnAdd) this.abort();
    },
    removeEventListener(type, listener) {
      this.removed.push({ type, listener });
      if (options.removeThrows) throw new Error("remove failed");
    },
    abort() {
      this.aborted = true;
      for (const { listener } of this.added) listener({ type: "abort" });
    },
  };
}

function makeToolContext(options = {}) {
  const metadata = [];
  return {
    sessionID: options.sessionID ?? nextSession(),
    directory: options.directory ?? "/repo",
    worktree: options.worktree ?? "/repo",
    abort: options.abort,
    metadata(input) {
      metadata.push(input);
    },
    metadataCalls: metadata,
  };
}

function makeClient(handlers = {}) {
  const calls = { messages: [], create: [], prompt: [], abort: [] };
  const defaultMessages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "Please advise" }] },
  ];

  const client = {
    ...(handlers.sessionShape ? { __advisorSessionShape: handlers.sessionShape } : {}),
    session: {
      async messages(input) {
        calls.messages.push(input);
        if (handlers.messages) return await handlers.messages(input, calls);
        return { data: defaultMessages };
      },
      async create(input) {
        calls.create.push(input);
        if (handlers.create) return await handlers.create(input, calls);
        return { data: { id: "child-session" } };
      },
      async prompt(input) {
        calls.prompt.push(input);
        if (handlers.prompt) return await handlers.prompt(input, calls);
        return { data: { info: {}, parts: [{ type: "text", text: "advisor text" }] } };
      },
      async abort(input) {
        calls.abort.push(input);
        if (handlers.abort) return await handlers.abort(input, calls);
        return { data: true };
      },
    },
  };
  if (handlers.abortMissing) delete client.session.abort;
  if (handlers.promptRaw) {
    client.session.prompt = (input) => {
      calls.prompt.push(input);
      return handlers.promptRaw(input, calls);
    };
  }

  return { client, calls };
}

async function makeHooks(handlers = {}, contextOverrides = {}) {
  const { client, calls } = makeClient(handlers);
  const hooks = await advisorPlugin({ client, ...contextOverrides });
  return { hooks, calls };
}

async function withAdvisorModelEnv(value, fn) {
  const original = process.env.OPENCODE_ADVISOR_MODEL;
  try {
    if (value === undefined) delete process.env.OPENCODE_ADVISOR_MODEL;
    else process.env.OPENCODE_ADVISOR_MODEL = value;
    return await fn();
  } finally {
    if (original === undefined) delete process.env.OPENCODE_ADVISOR_MODEL;
    else process.env.OPENCODE_ADVISOR_MODEL = original;
  }
}

async function executeWithSuccess(hooks, sessionID) {
  const toolContext = makeToolContext({ sessionID });
  const result = await hooks.tool.advisor.execute({ question: "Need advice" }, toolContext);
  return { result, toolContext };
}

async function assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, contextOptions = {}) {
  const toolContext = makeToolContext({ sessionID, ...contextOptions });
  const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.deepStrictEqual(toolContext.metadataCalls[0], {
    title: `Advisor 1/${MAX_CALLS_PER_SESSION}`,
    metadata: { advisorCalls: 1, maxAdvisorCalls: MAX_CALLS_PER_SESSION },
  });
  return { result, toolContext };
}

function assertNoAsk(value, path = "permission") {
  if (value === "ask") {
    assert.fail(`${path} must not be ask`);
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assertNoAsk(child, `${path}.${key}`);
  }
}

function assertCredentialPathDenies(permission) {
  for (const toolName of ["read", "list", "glob", "grep"]) {
    const toolPermission = permission[toolName];
    const orderedPatterns = Object.keys(toolPermission);
    const wildcardIndex = orderedPatterns.indexOf("*");
    assert.equal(toolPermission["*"], "allow", `${toolName} keeps normal workspace inspection`);
    assert.notEqual(wildcardIndex, -1, `${toolName} includes wildcard allow`);
    for (const pattern of [
      ".env*",
      "**/.env*",
      "*.pem",
      "**/*.key",
      "secrets",
      "secrets/**",
      "**/secrets/**",
      "secrets.*",
      "credentials/**",
      "**/credentials/**",
      "**/credentials.*",
      ".beads-credential-key",
      ".npmrc",
      "**/.pypirc",
      "~/.netrc",
      ".docker/config.json",
      "**/.kube/config",
      "kubeconfig.*",
      "**/id_ed25519",
      "*.p12",
      "**/*.pfx",
      ".git-credentials",
      "**/.ssh/*",
      "~/.aws/*",
      "~/.azure/*",
      "~/.config/gcloud/*",
      "~/.config/gh/hosts.yml",
    ]) {
      assert.equal(toolPermission[pattern], "deny", `${toolName} denies ${pattern}`);
      assert.ok(
        orderedPatterns.indexOf(pattern) > wildcardIndex,
        `${toolName} ${pattern} must appear after * so the credential hard-deny wins`,
      );
    }
  }
}

function assertBashCredentialPathDenies(bash, allowPattern = "git show *") {
  const orderedPatterns = Object.keys(bash);
  const allowIndex = orderedPatterns.indexOf(allowPattern);
  assert.notEqual(allowIndex, -1, `${allowPattern} must be present`);
  for (const pattern of [
    "*.env*",
    "*.pem*",
    "*.key*",
    "*secrets*",
    "*secrets.*",
    "*credentials*",
    "*.beads-credential-key*",
    "*.npmrc*",
    "*.yarnrc*",
    "*.pnpmrc*",
    "*.pypirc*",
    "*.netrc*",
    "*.git-credentials*",
    "*.docker/config.json*",
    "*.kube/config*",
    "*kubeconfig*",
    "*id_rsa*",
    "*id_ed25519*",
    "*.p12*",
    "*.pfx*",
    "*.ssh*",
    "*.aws*",
    "*.azure*",
    "*.config/gcloud*",
    "*.config/gh/hosts.yml*",
  ]) {
    assert.equal(bash[pattern], "deny", `bash denies ${pattern}`);
    assert.ok(
      orderedPatterns.indexOf(pattern) > allowIndex,
      `${pattern} must appear after ${allowPattern} so the credential hard-deny wins`,
    );
  }
}

function assertHardDeniesWinAfterOperatorRules(
  permission,
  pairs,
  { operatorAction = "allow", hardDenyLabel = "hard-deny" } = {},
) {
  const orderedPatterns = Object.keys(permission);
  for (const [operatorPattern, hardDenyPattern] of pairs) {
    assert.equal(permission[operatorPattern], operatorAction);
    assert.equal(permission[hardDenyPattern], "deny");
    assert.ok(
      orderedPatterns.indexOf(hardDenyPattern) > orderedPatterns.indexOf(operatorPattern),
      `${hardDenyPattern} must appear after ${operatorPattern} so the ${hardDenyLabel} wins`,
    );
  }
}

// --- config hook ------------------------------------------------------------

test("config hook installs hardened advisor-strategist permissions without auto-allowing executors", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    model: "openai/gpt-5.5",
    agent: {
      build: { permission: { bash: "ask" } },
    },
  };

  await hooks.config(cfg);

  assert.equal(cfg.permission, undefined);
  assert.deepStrictEqual(cfg.agent.build.permission, { bash: "ask" });

  const advisor = cfg.agent[ADVISOR_AGENT];
  assert.equal(advisor.mode, "primary");
  assert.equal(advisor.hidden, true);
  assert.match(advisor.description, /Hidden high-capability advisor/);
  assert.equal(advisor.temperature, 0.1);
  assert.equal(advisor.steps, 12);
  assert.equal(advisor.model, "openai/gpt-5.5");
  assertNoAsk(advisor.permission);
  assert.equal(advisor.permission["*"], "deny");
  assertCredentialPathDenies(advisor.permission);
  assert.equal(advisor.permission.webfetch, "deny");
  assert.equal(advisor.permission.websearch, "deny");
  assert.equal(advisor.permission.edit, "deny");
  assert.equal(advisor.permission.write, "deny");
  assert.equal(advisor.permission.apply_patch, "deny");
  assert.equal(advisor.permission.patch, "deny");
  assert.equal(advisor.permission.advisor, "deny");
  assert.equal(advisor.permission.bash["*"], "deny");
  assert.ok(
    Object.keys(advisor.permission.bash).indexOf("*") <
      Object.keys(advisor.permission.bash).indexOf("git status"),
    "wildcard bash deny must stay before read-only allows",
  );
  assert.equal(advisor.permission.bash["git status"], "allow");
  assert.equal(advisor.permission.bash["git status *"], "allow");
  assert.equal(advisor.permission.bash["git ls-files"], "allow");
  assert.equal(advisor.permission.bash["git ls-files *"], "allow");
  assert.equal(advisor.permission.bash["rg"], "allow");
  assert.equal(advisor.permission.bash["grep"], "allow");
  assert.equal(advisor.permission.bash["rg *"], "deny");
  assert.equal(advisor.permission.bash["grep *"], "deny");
  assert.equal(advisor.permission.bash["node --check *"], "deny");
  assert.equal(advisor.permission.bash["rg *--follow*"], "deny");
  assert.equal(advisor.permission.bash["grep -R*"], "deny");
  assertBashCredentialPathDenies(advisor.permission.bash);
  assert.equal(advisor.permission.bash["git branch"], "allow");
  assert.equal(advisor.permission.bash["git branch *"], undefined);
  assert.equal(advisor.permission.bash["git branch --show-current"], "allow");
  assert.equal(advisor.permission.bash["git branch --list"], "allow");
  assert.equal(advisor.permission.bash["git branch --list *"], "allow");
  assert.equal(advisor.permission.bash["git push*"], "deny");
  assert.equal(advisor.permission.bash["git branch -D*"], "deny");
  assert.equal(advisor.permission.bash["git diff *--output*"], "deny");
  assert.equal(advisor.permission.bash["git show *--ext-diff*"], "deny");
  assert.equal(advisor.permission.bash["* /*"], "deny");
  assert.equal(advisor.permission.bash["* ../*"], "deny");
  assert.equal(advisor.permission.bash["rm *"], "deny");
  assert.equal(advisor.permission.bash["mv *"], "deny");
  assert.equal(advisor.permission.bash["*<*"], "deny");
  assert.equal(advisor.permission.bash["*;*"], "deny");
  assert.equal(advisor.permission.bash["*&&*"], "deny");
  assert.equal(advisor.permission.bash["*|*"], "deny");
  assert.equal(advisor.permission.bash["*$(*"], "deny");
  assert.notEqual(advisor.permission.bash["*"], "allow");
});

test("config hook preserves operator hardening on existing advisor-strategist config", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    model: "openai/default",
    agent: {
      [ADVISOR_AGENT]: {
        model: "openai/operator-choice",
        permission: {
          read: "deny",
          bash: {
            "*": "deny",
            "git status *": "deny",
            "curl *": "deny",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const advisor = cfg.agent[ADVISOR_AGENT];
  assert.equal(advisor.model, "openai/operator-choice");
  assert.equal(advisor.mode, "primary");
  assert.equal(advisor.hidden, true);
  assertNoAsk(advisor.permission);
  assert.equal(advisor.permission.read, "deny");
  assert.equal(advisor.permission.edit, "deny");
  assert.equal(advisor.permission.write, "deny");
  assert.equal(advisor.permission.apply_patch, "deny");
  assert.equal(advisor.permission.patch, "deny");
  assert.equal(advisor.permission.advisor, "deny");
  assert.equal(advisor.permission.bash["*"], "deny");
  assert.equal(advisor.permission.bash["git status"], "deny");
  assert.equal(advisor.permission.bash["git status *"], "deny");
  assert.equal(advisor.permission.bash["curl *"], "deny");
});

test("config hook preserves existing advisor-strategist description", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        description: "Operator-provided advisor notes.",
      },
    },
  };

  await hooks.config(cfg);

  assert.equal(cfg.agent[ADVISOR_AGENT].description, "Operator-provided advisor notes.");
});

test("config hook honors scalar advisor-strategist hardening", async () => {
  for (const permission of ["deny", "ask", "allow"]) {
    const { hooks } = await makeHooks();
    const cfg = { agent: { [ADVISOR_AGENT]: { permission } } };

    await hooks.config(cfg);

    const advisorPermission = cfg.agent[ADVISOR_AGENT].permission;
    assertNoAsk(advisorPermission);
    if (permission === "deny" || permission === "ask") {
      assert.equal(advisorPermission["*"], "deny");
      assert.equal(advisorPermission.read, "deny");
      assert.equal(advisorPermission.webfetch, "deny");
      assert.equal(advisorPermission.bash, "deny");
    } else {
      assert.equal(advisorPermission.read["*"], "allow");
      assert.equal(advisorPermission.read[".env*"], "deny");
      assert.equal(advisorPermission.webfetch, "deny");
      assert.equal(advisorPermission.bash["*"], "deny");
    }
    assert.equal(advisorPermission.edit, "deny");
    assert.equal(advisorPermission.write, "deny");
    assert.equal(advisorPermission.apply_patch, "deny");
    assert.equal(advisorPermission.patch, "deny");
    assert.equal(advisorPermission.advisor, "deny");
  }
});

test("config hook does not auto-allow advisor for executor agents with scalar permissions", async () => {
  for (const permission of ["deny", "ask", "allow"]) {
    const { hooks } = await makeHooks();
    const cfg = { agent: { build: { permission } } };

    await hooks.config(cfg);

    assert.equal(cfg.agent.build.permission, permission);
  }
});

test("config hook does not auto-allow advisor globally with scalar permissions", async () => {
  for (const permission of ["deny", "ask", "allow"]) {
    const { hooks } = await makeHooks();
    const cfg = { permission, agent: {} };

    await hooks.config(cfg);

    assert.equal(cfg.permission, permission);
  }
});

test("config hook preserves explicit operator advisor tool opt-ins", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    permission: { advisor: "allow", bash: "deny" },
    agent: {
      build: { permission: { advisor: "allow", read: "deny" } },
      review: { permission: { advisor: "deny", read: "allow" } },
    },
  };

  await hooks.config(cfg);

  assert.deepStrictEqual(cfg.permission, { advisor: "allow", bash: "deny" });
  assert.deepStrictEqual(cfg.agent.build.permission, { advisor: "allow", read: "deny" });
  assert.deepStrictEqual(cfg.agent.review.permission, { advisor: "deny", read: "allow" });
  assert.equal(cfg.agent[ADVISOR_AGENT].permission.advisor, "deny");
});

test("config hook does not let broad operator allow weaken the shell allowlist", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: { bash: { "*": "allow" } },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(cfg.agent[ADVISOR_AGENT].permission);
  assert.equal(bash["*"], "deny");
  assert.equal(bash["git push*"], "deny");
});

test("config hook permits explicit non-hard-denied bash opt-ins", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          bash: {
            "npm test": "allow",
            "curl *": "allow",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(bash);
  assert.equal(bash["*"], "deny");
  assert.equal(bash["npm test"], "allow");
  assert.equal(bash["curl *"], "allow");
  assert.equal(bash["git push*"], "deny");
});

test("config hook drops protected sibling glob permissions that would weaken advisor hardening", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          "b*": "ask",
          "e*": "ask",
          "write*": "ask",
          "advisor*": "ask",
          "edit*": "deny",
        },
      },
    },
  };

  await hooks.config(cfg);

  const permission = cfg.agent[ADVISOR_AGENT].permission;
  assertNoAsk(permission);
  assert.equal(Object.hasOwn(permission, "b*"), false);
  assert.equal(Object.hasOwn(permission, "e*"), false);
  assert.equal(Object.hasOwn(permission, "write*"), false);
  assert.equal(Object.hasOwn(permission, "advisor*"), false);
  assert.equal(permission["edit*"], "deny");
  assert.equal(permission.bash["git push*"], "deny");
  assert.equal(permission.edit, "deny");
});

test("config hook drops filesystem sibling glob permissions that would bypass credential hard-denies", async () => {
  // Regression for advisor-0rb: an operator sibling glob that matches a
  // filesystem research tool name (r*/g*/l*/gr*/gre*) must not be appended
  // after the exact default object, where OpenCode's last-match-wins rule
  // resolution would let it override the credential-path hard-denies.
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          "r*": "allow",
          "g*": { "**/.env": "allow" },
          "l*": "allow",
          "gr*": "allow",
          "gre*": "ask",
        },
      },
    },
  };

  await hooks.config(cfg);

  const permission = cfg.agent[ADVISOR_AGENT].permission;
  assertNoAsk(permission);
  // Sibling globs matching filesystem tools are neutralized (dropped), so the
  // exact default objects retain final precedence.
  assert.equal(Object.hasOwn(permission, "r*"), false, "r* must not survive");
  assert.equal(Object.hasOwn(permission, "g*"), false, "g* must not survive");
  assert.equal(Object.hasOwn(permission, "l*"), false, "l* must not survive");
  assert.equal(Object.hasOwn(permission, "gr*"), false, "gr* must not survive");
  assert.equal(Object.hasOwn(permission, "gre*"), false, "gre* must not survive");
  // The exact defaults keep their credential-path hard-denies and normal allows.
  assertCredentialPathDenies(permission);
});

test("config hook preserves filesystem sibling glob deny as operator hardening", async () => {
  // A sibling glob that hardens (deny) a filesystem tool is preserved, mirroring
  // the bash/edit deny behavior. Only non-deny sibling globs are dropped.
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          "r*": "deny",
          "g*": "deny",
        },
      },
    },
  };

  await hooks.config(cfg);

  const permission = cfg.agent[ADVISOR_AGENT].permission;
  assert.equal(permission["r*"], "deny", "r* deny is preserved as operator hardening");
  assert.equal(permission["g*"], "deny", "g* deny is preserved as operator hardening");
});

test("config hook keeps built-in bash hard-denies after operator overrides", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          bash: {
            "rm -rf *": "ask",
            "git push origin main": "ask",
            "npm publish --access public": "ask",
            "docker system prune --all": "ask",
            "curl *": "deny",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(bash);
  assertHardDeniesWinAfterOperatorRules(
    bash,
    [
      ["rm -rf *", "rm *"],
      ["git push origin main", "git push*"],
      ["npm publish --access public", "npm publish*"],
      ["docker system prune --all", "docker system prune*"],
    ],
    { operatorAction: "deny" },
  );

  assert.equal(bash["curl *"], "deny");
});

test("config hook keeps shell metacharacter and native-write hard-denies after operator allows", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          bash: {
            "rg token | cat": "allow",
            "git diff --output=/tmp/out": "allow",
            "git show --ext-diff HEAD": "allow",
            "ls /etc": "allow",
            "git show --format=$HOME HEAD": "allow",
            "ls --directory=/etc": "allow",
            "ls --directory=~/.ssh": "allow",
            "grep secret ../outside": "allow",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(bash);
  assertHardDeniesWinAfterOperatorRules(bash, [
    ["rg token | cat", "*|*"],
    ["git diff --output=/tmp/out", "git diff *--output*"],
    ["git show --ext-diff HEAD", "git show *--ext-diff*"],
    ["ls /etc", "* /*"],
    ["git show --format=$HOME HEAD", "*=$*"],
    ["ls --directory=/etc", "*=/*"],
    ["ls --directory=~/.ssh", "*=~*"],
    ["grep secret ../outside", "*../*"],
  ]);
});

test("config hook keeps shell search and path-read hard-denies after operator allows", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          bash: {
            "rg token": "allow",
            "grep token README.md": "allow",
            "node --check linked-file": "allow",
            "rg --follow token": "allow",
            "rg -L token": "allow",
            "grep -R token .": "allow",
            "grep --dereference-recursive token .": "allow",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(bash);
  assertHardDeniesWinAfterOperatorRules(bash, [
    ["rg token", "rg *"],
    ["grep token README.md", "grep *"],
    ["node --check linked-file", "node --check *"],
    ["rg --follow token", "rg *--follow*"],
    ["rg -L token", "rg -L*"],
    ["grep -R token .", "grep -R*"],
    ["grep --dereference-recursive token .", "grep --dereference-recursive*"],
  ]);
});

test("config hook keeps credential-path bash hard-denies after operator allows", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          bash: {
            "grep token .env": "allow",
            "rg PRIVATE_KEY id_rsa.pem": "allow",
            "git show HEAD:.env.local": "allow",
            "git ls-files credentials": "allow",
            "git show HEAD:secrets/api-token": "allow",
            "git show HEAD:credentials/service.json": "allow",
            "git show HEAD:.npmrc": "allow",
            "git show HEAD:.docker/config.json": "allow",
            "git show HEAD:kubeconfig.prod": "allow",
            "git show HEAD:id_ed25519": "allow",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(bash);
  assertHardDeniesWinAfterOperatorRules(
    bash,
    [
      ["grep token .env", "*.env*"],
      ["rg PRIVATE_KEY id_rsa.pem", "*.pem*"],
      ["git show HEAD:.env.local", "*.env*"],
      ["git ls-files credentials", "*credentials*"],
      ["git show HEAD:secrets/api-token", "*secrets*"],
      ["git show HEAD:credentials/service.json", "*credentials*"],
      ["git show HEAD:.npmrc", "*.npmrc*"],
      ["git show HEAD:.docker/config.json", "*.docker/config.json*"],
      ["git show HEAD:kubeconfig.prod", "*kubeconfig*"],
      ["git show HEAD:id_ed25519", "*id_ed25519*"],
    ],
    { hardDenyLabel: "credential hard-deny" },
  );
});

test("config hook keeps credential-path filesystem hard-denies after operator allows", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          read: {
            ".env.local": "allow",
            ".env*": "allow",
            "src/.npmrc": "allow",
          },
          list: {
            ".aws/credentials": "allow",
            "src/.docker/config.json": "allow",
            "secrets/api-token": "allow",
          },
          glob: {
            "src/private.pem": "allow",
            "**/*.pem": "allow",
            "credentials/service.json": "allow",
            "kubeconfig.prod": "allow",
            "certs/client.pfx": "allow",
          },
          grep: {
            "credentials.prod": "allow",
            "src/.ssh/id_ed25519": "allow",
            "src/id_ed25519": "allow",
            "src/.git-credentials": "allow",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const permission = cfg.agent[ADVISOR_AGENT].permission;
  assertNoAsk(permission);
  for (const [toolName, operatorPattern, hardDenyPattern] of [
    ["read", ".env.local", ".env*"],
    ["read", "src/.npmrc", "**/.npmrc"],
    ["list", ".aws/credentials", ".aws/*"],
    ["list", "src/.docker/config.json", "**/.docker/config.json"],
    ["list", "secrets/api-token", "secrets/**"],
    ["glob", "src/private.pem", "**/*.pem"],
    ["glob", "credentials/service.json", "credentials/**"],
    ["glob", "kubeconfig.prod", "kubeconfig.*"],
    ["glob", "certs/client.pfx", "**/*.pfx"],
    ["grep", "credentials.prod", "credentials.*"],
    ["grep", "src/.ssh/id_ed25519", "**/.ssh/*"],
    ["grep", "src/id_ed25519", "**/id_ed25519"],
    ["grep", "src/.git-credentials", "**/.git-credentials"],
  ]) {
    const toolPermission = permission[toolName];
    const orderedPatterns = Object.keys(toolPermission);
    assert.equal(toolPermission["*"], "allow", `${toolName} keeps workspace inspection`);
    assert.equal(toolPermission[operatorPattern], "allow", `${toolName} keeps operator allow`);
    assert.equal(toolPermission[hardDenyPattern], "deny", `${toolName} denies ${hardDenyPattern}`);
    assert.ok(
      orderedPatterns.indexOf(hardDenyPattern) > orderedPatterns.indexOf(operatorPattern),
      `${hardDenyPattern} must appear after ${operatorPattern} so the credential hard-deny wins`,
    );
  }
  assert.equal(permission.read[".env*"], "deny");
  assertCredentialPathDenies(permission);
});

test("config hook keeps exact built-in bash hard-denies after operator allow overrides", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          bash: {
            "rm *": "allow",
            "git push*": "allow",
          },
        },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(bash);
  assert.equal(bash["rm *"], "deny");
  assert.equal(bash["git push*"], "deny");
});

test("config hook normalizes scalar bash ask to deny", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: { bash: "ask" },
      },
    },
  };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assert.equal(bash, "deny");
});

test("config hook denies project-code execution commands by default", async () => {
  const { hooks } = await makeHooks();
  const cfg = { agent: {} };

  await hooks.config(cfg);

  const bash = cfg.agent[ADVISOR_AGENT].permission.bash;
  assertNoAsk(bash);
  assert.equal(bash["*"], "deny");

  for (const command of [
    "node --test",
    "node --test *",
    "npm test",
    "npm test *",
    "npm run test",
    "npm run test *",
    "bun test",
    "bun test *",
  ]) {
    assert.notEqual(bash[command], "allow", `${command} must not be auto-allowed`);
  }
});

test("config hook supports nested non-bash permission objects without widening defaults", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          read: { "secrets/*": "deny" },
          grep: { "*": "ask", "blocked/*": "deny" },
        },
      },
    },
  };

  await hooks.config(cfg);

  const permission = cfg.agent[ADVISOR_AGENT].permission;
  assertNoAsk(permission);
  assert.equal(permission.read["*"], "allow");
  assert.equal(permission.read["secrets/*"], "deny");
  assert.equal(permission.grep["*"], "deny");
  assert.equal(permission.grep["blocked/*"], "deny");
});

test("config hook keeps raw web tools denied while permitting explicit non-protected opt-ins", async () => {
  const { hooks } = await makeHooks();
  const cfg = {
    agent: {
      [ADVISOR_AGENT]: {
        permission: {
          webfetch: "allow",
          websearch: "allow",
          unknownAllow: "allow",
          unknownAsk: "ask",
          unknownDeny: "deny",
          edit: "allow",
          write: "allow",
          apply_patch: "allow",
          patch: "allow",
          advisor: "allow",
        },
      },
    },
  };

  await hooks.config(cfg);

  const permission = cfg.agent[ADVISOR_AGENT].permission;
  assertNoAsk(permission);
  assert.equal(permission.webfetch, "deny");
  assert.equal(permission.websearch, "deny");
  assert.equal(permission.unknownAllow, "allow");
  assert.equal(permission.unknownAsk, "deny");
  assert.equal(permission.unknownDeny, "deny");
  assert.equal(permission.edit, "deny");
  assert.equal(permission.write, "deny");
  assert.equal(permission.apply_patch, "deny");
  assert.equal(permission.patch, "deny");
  assert.equal(permission.advisor, "deny");
});

// --- chat.params hook -------------------------------------------------------

test("chat.params applies high OpenAI reasoning for advisor-strategist", async () => {
  const { hooks } = await makeHooks();
  const output = {
    options: {
      providerOptions: {
        anthropic: { keep: true },
        openai: { previous: "value" },
      },
    },
  };

  await hooks["chat.params"]({ agent: ADVISOR_AGENT, provider: "openai" }, output);

  assert.equal(output.options.providerOptions.openai.reasoningEffort, "high");
  assert.equal(output.options.providerOptions.openai.previous, "value");
  assert.deepStrictEqual(output.options.providerOptions.anthropic, { keep: true });
});

test("chat.params applies high OpenAI reasoning when output has no options", async () => {
  const { hooks } = await makeHooks();
  const output = {};

  await hooks["chat.params"]({ agent: ADVISOR_AGENT, provider: "openai" }, output);

  assert.equal(output.options.providerOptions.openai.reasoningEffort, "high");
});

test("chat.params reads OpenAI provider from real ProviderContext input", async () => {
  const { hooks } = await makeHooks();
  const output = {};

  await hooks["chat.params"]({
    agent: ADVISOR_AGENT,
    provider: { source: "env", info: { id: "openai" }, options: {} },
  }, output);

  assert.equal(output.options.providerOptions.openai.reasoningEffort, "high");
});

test("chat.params reads OpenAI provider from combined model strings", async () => {
  const { hooks } = await makeHooks();
  const output = {};

  await hooks["chat.params"]({ agent: ADVISOR_AGENT, model: "openai/gpt-5.5" }, output);

  assert.equal(output.options.providerOptions.openai.reasoningEffort, "high");
});

test("chat.params reads OpenAI provider from model provider fields", async () => {
  const { hooks } = await makeHooks();
  const output = {};

  await hooks["chat.params"]({ agent: ADVISOR_AGENT, model: { providerID: "openai" } }, output);

  assert.equal(output.options.providerOptions.openai.reasoningEffort, "high");
});

test("chat.params does not write OpenAI reasoning settings for non-OpenAI providers", async () => {
  const { hooks } = await makeHooks();
  const output = { options: { providerOptions: { anthropic: { keep: true } } } };

  await hooks["chat.params"]({ agent: ADVISOR_AGENT, provider: "anthropic" }, output);

  assert.deepStrictEqual(output, { options: { providerOptions: { anthropic: { keep: true } } } });
});

test("chat.params skips OpenAI reasoning for non-OpenAI model provider fields", async () => {
  const { hooks } = await makeHooks();
  const output = { options: { providerOptions: { anthropic: { keep: true } } } };

  await hooks["chat.params"]({ agent: ADVISOR_AGENT, model: { providerId: "anthropic" } }, output);

  assert.deepStrictEqual(output, { options: { providerOptions: { anthropic: { keep: true } } } });
});

test("chat.params skips OpenAI reasoning for non-OpenAI combined model strings", async () => {
  const { hooks } = await makeHooks();
  const output = { options: { providerOptions: { anthropic: { keep: true } } } };

  await hooks["chat.params"]({ agent: ADVISOR_AGENT, model: "anthropic/claude-3-5-sonnet" }, output);

  assert.deepStrictEqual(output, { options: { providerOptions: { anthropic: { keep: true } } } });
});

test("chat.params skips OpenAI reasoning when provider cannot be determined", async () => {
  const { hooks } = await makeHooks();
  const output = {};

  await hooks["chat.params"]({ agent: ADVISOR_AGENT }, output);

  assert.deepStrictEqual(output, {});
});

test("chat.params skips ProviderContext input for non-OpenAI providers", async () => {
  const { hooks } = await makeHooks();
  const output = { options: { providerOptions: { anthropic: { keep: true } } } };

  await hooks["chat.params"]({
    agent: ADVISOR_AGENT,
    provider: { source: "env", info: { id: "anthropic" }, options: {} },
  }, output);

  assert.deepStrictEqual(output, { options: { providerOptions: { anthropic: { keep: true } } } });
});

test("chat.params ignores empty provider candidates before non-OpenAI providers", async () => {
  const { hooks } = await makeHooks();
  const output = { options: { providerOptions: { anthropic: { keep: true } } } };

  await hooks["chat.params"]({
    agent: ADVISOR_AGENT,
    provider: { id: "", providerID: "   ", info: { id: "anthropic" } },
  }, output);

  assert.deepStrictEqual(output, { options: { providerOptions: { anthropic: { keep: true } } } });
});

test("chat.params leaves non-advisor agents unchanged", async () => {
  const { hooks } = await makeHooks();
  const output = { options: { providerOptions: { openai: { previous: "value" } } } };

  await hooks["chat.params"]({ agent: "build" }, output);

  assert.deepStrictEqual(output, { options: { providerOptions: { openai: { previous: "value" } } } });
});

// --- tool schema and child-session success path ----------------------------

test("advisor tool schema and runtime reject oversized question/context before child setup", async () => {
  const { hooks, calls } = await makeHooks();

  assert.equal(hooks.tool.advisor.args.question.safeParse("q".repeat(MAX_QUESTION_CHARS + 1)).success, false);
  assert.equal(hooks.tool.advisor.args.context.safeParse("c".repeat(MAX_CONTEXT_CHARS + 1)).success, false);

  const blankQuestionContext = makeToolContext();
  const blankQuestionResult = await hooks.tool.advisor.execute(
    { question: " \n\t " },
    blankQuestionContext,
  );

  assert.match(blankQuestionResult, /question is required/i);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(blankQuestionContext.metadataCalls.length, 0);

  const toolContext = makeToolContext();
  const result = await hooks.tool.advisor.execute(
    { question: "q".repeat(MAX_QUESTION_CHARS + 1) },
    toolContext,
  );

  assert.match(result, /question is too long/i);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  const contextResult = await hooks.tool.advisor.execute(
    { question: "ok", context: { bad: true } },
    makeToolContext(),
  );
  assert.match(contextResult, /context must be a string/i);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
});

test("advisor execute rejects malformed session IDs before budget and session APIs", async () => {
  const { hooks, calls } = await makeHooks();

  for (const badSessionID of ["", "   ", 42]) {
    const toolContext = makeToolContext({ sessionID: badSessionID });
    const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);

    assert.match(result, /could not identify the current session/i);
    assert.equal(toolContext.metadataCalls.length, 0);
  }

  const missingContext = makeToolContext();
  delete missingContext.sessionID;
  const missingResult = await hooks.tool.advisor.execute({ question: "Advice?" }, missingContext);
  assert.match(missingResult, /could not identify the current session/i);
  assert.equal(missingContext.metadataCalls.length, 0);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.abort.length, 0);

  const validContext = makeToolContext({ sessionID: nextSession("valid-after-bad-session") });
  const validResult = await hooks.tool.advisor.execute({ question: "Advice?" }, validContext);
  assert.equal(validResult, "advisor text");
  assert.equal(validContext.metadataCalls[0].title, `Advisor 1/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute creates and prompts an isolated child session", async () => {
  const { hooks, calls } = await makeHooks();
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const toolContext = makeToolContext({ sessionID: nextSession("child-path") });
  const result = await hooks.tool.advisor.execute(
    { question: "Should I refactor?", context: "Need a second opinion" },
    toolContext,
  );

  assert.equal(result, "advisor text");
  assert.equal(calls.messages.length, 1);
  assert.deepStrictEqual(calls.messages[0].path, { id: toolContext.sessionID });
  assert.deepStrictEqual(calls.messages[0].query, { directory: toolContext.directory, limit: 80 });
  assert.equal(calls.create.length, 1);
  assert.deepStrictEqual(calls.create[0].query, { directory: toolContext.directory });
  assert.equal(calls.create[0].body.parentID, toolContext.sessionID);
  assert.equal(calls.create[0].body.title, "Advisor consultation");
  assert.equal(calls.prompt.length, 1);

  const prompt = calls.prompt[0];
  assert.deepStrictEqual(prompt.path, { id: "child-session" });
  assert.deepStrictEqual(prompt.query, { directory: toolContext.directory });
  assert.equal(prompt.body.agent, ADVISOR_AGENT);
  assert.deepStrictEqual(prompt.body.model, { providerID: "openai", modelID: "gpt-5.5" });
  assert.deepStrictEqual(prompt.body.tools, {
    advisor: false,
    edit: false,
    write: false,
    apply_patch: false,
    patch: false,
  });
  assert.equal(prompt.body.parts.length, 1);
  assert.equal(prompt.body.parts[0].type, "text");
  assert.equal(prompt.body.parts[0].synthetic, true);
  assert.equal(prompt.body.parts[0].metadata.source, "advisor-plugin");
  assert.equal(prompt.body.parts[0].metadata.kind, "consultation");
  assert.match(prompt.body.parts[0].text, /Should I refactor/);
  assert.match(prompt.body.parts[0].text, /Do not edit files/);
});

test("advisor execute redacts parent transcript secrets in the child prompt", async () => {
  const { hooks, calls } = await makeHooks({
    messages: async () => ({
      data: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "OPENAI_API_KEY=sk-12345678901234567890" }],
        },
        {
          info: { role: "assistant", agent: "build" },
          parts: [{ type: "tool_result", tool: "bash", output: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }],
        },
      ],
    }),
  });

  const result = await hooks.tool.advisor.execute({ question: "Advice?" }, makeToolContext());

  assert.equal(result, "advisor text");
  const promptText = calls.prompt[0].body.parts[0].text;
  assert.ok(promptText.includes("OPENAI_API_KEY=[REDACTED]"));
  assert.ok(promptText.includes("Authorization: Bearer [REDACTED]"));
  assert.ok(!promptText.includes("sk-12345678901234567890"));
  assert.ok(!promptText.includes("abcdefghijklmnopqrstuvwxyz"));
});

test("advisor execute omits child model when no model resolves", async () => {
  await withAdvisorModelEnv(undefined, async () => {
    const { hooks, calls } = await makeHooks();
    await hooks.config({ agent: {} });

    await executeWithSuccess(hooks, nextSession("no-model"));

    assert.equal(Object.hasOwn(calls.prompt[0].body, "model"), false);
  });
});

test("advisor execute sends the resolved model from env and agent config", async () => {
  await withAdvisorModelEnv("openai/from-env", async () => {
    const envCase = await makeHooks();
    await envCase.hooks.config({
      model: "openai/from-config",
      agent: { [ADVISOR_AGENT]: { model: "openai/from-agent" } },
    });
    await executeWithSuccess(envCase.hooks, nextSession("env-model"));
    assert.deepStrictEqual(envCase.calls.prompt[0].body.model, { providerID: "openai", modelID: "from-env" });
  });

  await withAdvisorModelEnv(undefined, async () => {
    const agentCase = await makeHooks();
    await agentCase.hooks.config({
      model: "openai/from-config",
      agent: { [ADVISOR_AGENT]: { model: "openai/from-agent" } },
    });
    await executeWithSuccess(agentCase.hooks, nextSession("agent-model"));
    assert.deepStrictEqual(agentCase.calls.prompt[0].body.model, { providerID: "openai", modelID: "from-agent" });
  });
});

test("advisor execute trims resolved model candidates before using them", async () => {
  await withAdvisorModelEnv("  openai/from-env  ", async () => {
    const { hooks, calls } = await makeHooks();
    await hooks.config({
      model: "openai/from-config",
      agent: { [ADVISOR_AGENT]: { model: "openai/from-agent" } },
    });

    await executeWithSuccess(hooks, nextSession("trimmed-env-model"));

    assert.deepStrictEqual(calls.prompt[0].body.model, { providerID: "openai", modelID: "from-env" });
  });
});

test("advisor execute omits malformed resolved model strings", async () => {
  await withAdvisorModelEnv(undefined, async () => {
    for (const model of ["gpt-5.5", "openai/", "/gpt-5.5"]) {
      const { hooks, calls } = await makeHooks();
      await hooks.config({ model, agent: {} });

      await executeWithSuccess(hooks, nextSession(`bad-model-${model.replace(/\W/g, "-")}`));

      assert.equal(Object.hasOwn(calls.prompt[0].body, "model"), false);
    }
  });
});

test("advisor execute ignores malformed env advisor model and uses configured fallback", async () => {
  await withAdvisorModelEnv("bad-model", async () => {
    const { hooks, calls } = await makeHooks();
    await hooks.config({
      model: "openai/from-config",
      agent: { [ADVISOR_AGENT]: { model: "openai/from-agent" } },
    });

    await executeWithSuccess(hooks, nextSession("bad-env-model"));

    assert.deepStrictEqual(calls.prompt[0].body.model, { providerID: "openai", modelID: "from-agent" });
  });
});

test("resolved advisor model is kept per plugin factory instance", async () => {
  const first = await makeHooks();
  const second = await makeHooks();
  await first.hooks.config({ model: "openai/first", agent: {} });
  await second.hooks.config({ model: "openai/second", agent: {} });

  await executeWithSuccess(first.hooks, nextSession("factory-first"));
  await executeWithSuccess(second.hooks, nextSession("factory-second"));

  assert.deepStrictEqual(first.calls.prompt[0].body.model, { providerID: "openai", modelID: "first" });
  assert.deepStrictEqual(second.calls.prompt[0].body.model, { providerID: "openai", modelID: "second" });
});

test("advisor execute supports v2 session API request shapes", async () => {
  const { hooks, calls } = await makeHooks({
    sessionShape: "v2",
    messages: async () => ({
      data: [
        { type: "user", text: "Need advice" },
        {
          type: "assistant",
          agent: "build",
          content: [{ type: "text", id: "part-1", text: "Prior answer" }],
        },
      ],
    }),
    create: async () => ({ data: { id: "child-v2" } }),
  });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const toolContext = makeToolContext({ sessionID: nextSession("v2") });
  const result = await hooks.tool.advisor.execute({ question: "Use v2?" }, toolContext);

  assert.equal(result, "advisor text");
  assert.deepStrictEqual(calls.messages[0], {
    sessionID: toolContext.sessionID,
    directory: toolContext.directory,
    limit: 80,
  });
  assert.deepStrictEqual(calls.create[0], {
    directory: toolContext.directory,
    parentID: toolContext.sessionID,
    title: "Advisor consultation",
  });
  assert.equal(calls.prompt[0].sessionID, "child-v2");
  assert.equal(calls.prompt[0].directory, toolContext.directory);
  assert.equal(calls.prompt[0].agent, ADVISOR_AGENT);
  assert.deepStrictEqual(calls.prompt[0].model, { providerID: "openai", modelID: "gpt-5.5" });
  assert.deepStrictEqual(calls.prompt[0].tools, {
    advisor: false,
    edit: false,
    write: false,
    apply_patch: false,
    patch: false,
  });
  assert.ok(calls.prompt[0].parts[0].text.includes("Prior answer"));
});

test("advisor execute supports top-level v2 session shape hints", async () => {
  for (const [label, contextOverrides] of [
    ["advisor", { __advisorSessionShape: "v2" }],
    ["workflow", { __workflowSessionShape: "v2" }],
  ]) {
    const { hooks, calls } = await makeHooks({}, contextOverrides);
    const toolContext = makeToolContext({ sessionID: nextSession(`ctx-${label}-v2`) });

    const result = await hooks.tool.advisor.execute({ question: "Use v2?" }, toolContext);

    assert.equal(result, "advisor text");
    assert.deepStrictEqual(calls.messages[0], {
      sessionID: toolContext.sessionID,
      directory: toolContext.directory,
      limit: 80,
    });
    assert.deepStrictEqual(calls.create[0], {
      directory: toolContext.directory,
      parentID: toolContext.sessionID,
      title: "Advisor consultation",
    });
    assert.equal(calls.prompt[0].sessionID, "child-session");
    assert.equal(calls.prompt[0].directory, toolContext.directory);
    assert.equal(calls.prompt[0].agent, ADVISOR_AGENT);
    assert.equal(Object.hasOwn(calls.prompt[0], "body"), false);
  }
});

// --- execute public contract and budget lifecycle --------------------------

test("advisor execute enforces budget and dispose does not clear shared counts", async () => {
  const sessionID = nextSession("dispose-budget");
  const first = await makeHooks();
  await first.hooks.config({ model: "openai/test", agent: {} });

  for (let i = 0; i < MAX_CALLS_PER_SESSION; i += 1) {
    const { result } = await executeWithSuccess(first.hooks, sessionID);
    assert.equal(result, "advisor text");
  }
  await first.hooks.dispose();

  const second = await makeHooks();
  const toolContext = makeToolContext({ sessionID });
  const result = await second.hooks.tool.advisor.execute({ question: "Again?" }, toolContext);

  assert.match(result, /budget reached/i);
  assert.equal(second.calls.messages.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);
});

test("advisor execute rolls back budget on messages result errors", async () => {
  let fail = true;
  const { hooks } = await makeHooks({
    messages: async () => (fail ? { error: { message: "no transcript" } } : { data: [] }),
  });
  const sessionID = nextSession("messages-error");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /could not read/i);
  assert.equal(toolContext.metadataCalls.length, 0);

  fail = false;
  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID);
});

test("advisor execute handles hostile rejected messages errors and rolls back budget", async () => {
  const hostile = {};
  Object.defineProperties(hostile, {
    name: {
      get() {
        throw new Error("name getter ghp_abcdefghijklmnopqrstuvwxyz123456");
      },
    },
    message: {
      get() {
        throw new Error("message getter sk-12345678901234567890");
      },
    },
    data: {
      get() {
        throw new Error("data getter secret");
      },
    },
  });

  let fail = true;
  const { hooks, calls } = await makeHooks({
    messages: async () => {
      if (fail) throw hostile;
      return { data: [] };
    },
  });
  const sessionID = nextSession("hostile-messages-error");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /Advisor consultation failed: Error/);
  assert.match(result, /Continue without advisor guidance/);
  assert.ok(!result.includes("ghp_"));
  assert.ok(!result.includes("sk-"));
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  fail = false;
  toolContext = makeToolContext({ sessionID });
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 1/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute handles malformed messages envelopes and data defensively", async () => {
  const messageResponses = [
    undefined,
    { data: { unexpected: true } },
    { data: [] },
  ];
  const { hooks, calls } = await makeHooks({
    messages: async () => messageResponses.shift(),
  });
  const sessionID = nextSession("messages-malformed");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /could not read/i);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID);
  assert.match(calls.prompt[0].body.parts[0].text, /No transcript was available/);

  toolContext = makeToolContext({ sessionID });
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 2/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute rolls back budget on child create errors and missing IDs", async () => {
  const responses = [{ error: { message: "create failed" } }, { data: {} }, { data: { id: "child-session" } }];
  const { hooks } = await makeHooks({ create: async () => responses.shift() });
  const sessionID = nextSession("create-error");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /could not create/i);
  assert.equal(toolContext.metadataCalls.length, 0);

  toolContext = makeToolContext({ sessionID });
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /could not create/i);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID);
});

test("advisor execute rolls back budget on malformed child create envelopes", async () => {
  const responses = [undefined, null, { data: { id: "child-session" } }];
  const { hooks, calls } = await makeHooks({ create: async () => responses.shift() });
  const sessionID = nextSession("create-malformed");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /could not create/i);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  toolContext = makeToolContext({ sessionID });
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /could not create/i);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID);
  assert.equal(calls.prompt.length, 1);
});

test("advisor execute rolls back only its own failed concurrent budget reservation", async () => {
  let createCount = 0;
  const { promise: firstCreateReady, resolve: firstCreateEntered } = Promise.withResolvers();
  const { promise: firstCreateRelease, resolve: releaseFirstCreate } = Promise.withResolvers();
  const { hooks } = await makeHooks({
    create: async () => {
      createCount += 1;
      if (createCount === 1) {
        firstCreateEntered();
        await firstCreateRelease;
        return { error: { message: "create failed" } };
      }
      return { data: { id: `child-${createCount}` } };
    },
  });
  const sessionID = nextSession("concurrent-rollback");

  const firstContext = makeToolContext({ sessionID });
  const first = hooks.tool.advisor.execute({ question: "First?" }, firstContext);
  await firstCreateReady;

  const secondContext = makeToolContext({ sessionID });
  const second = await hooks.tool.advisor.execute({ question: "Second?" }, secondContext);
  assert.equal(second, "advisor text");
  assert.equal(secondContext.metadataCalls[0].title, `Advisor 2/${MAX_CALLS_PER_SESSION}`);

  releaseFirstCreate();
  const firstResult = await first;
  assert.match(firstResult, /could not create/i);

  const thirdContext = makeToolContext({ sessionID });
  const third = await hooks.tool.advisor.execute({ question: "Third?" }, thirdContext);
  assert.equal(third, "advisor text");
  assert.equal(thirdContext.metadataCalls[0].title, `Advisor 2/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute handles rejected setup promises and rolls back budget", async () => {
  let messagesReject = true;
  let createReject = true;
  const messagesSession = nextSession("messages-throw");
  const createSession = nextSession("create-throw");

  const messagesCase = await makeHooks({
    messages: async () => {
      if (messagesReject) throw new Error("transport messages token=ghp_abcdefghijklmnopqrstuvwxyz123456");
      return { data: [] };
    },
  });
  let toolContext = makeToolContext({ sessionID: messagesSession });
  let result = await messagesCase.hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /transport messages/);
  assert.ok(result.includes("token=[REDACTED]"));
  assert.ok(!result.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"));
  assert.equal(toolContext.metadataCalls.length, 0);
  messagesReject = false;
  await assertNextConsultationStartsAtFirstBudgetCall(messagesCase.hooks, messagesSession);

  const createCase = await makeHooks({
    create: async () => {
      if (createReject) throw new Error("transport create");
      return { data: { id: "child-session" } };
    },
  });
  toolContext = makeToolContext({ sessionID: createSession });
  result = await createCase.hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /transport create/);
  assert.equal(toolContext.metadataCalls.length, 0);
  createReject = false;
  await assertNextConsultationStartsAtFirstBudgetCall(createCase.hooks, createSession);
});

test("advisor execute rolls back when session API methods are missing", async () => {
  const client = { session: {} };
  const hooks = await advisorPlugin({ client });
  const sessionID = nextSession("missing-session-methods");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /Advisor consultation failed/i);
  assert.match(result, /Continue without advisor guidance/);
  assert.equal(toolContext.metadataCalls.length, 0);

  client.session.messages = async () => ({ data: [] });
  client.session.create = async () => ({ data: { id: "child-session" } });
  client.session.prompt = async () => ({
    data: { info: {}, parts: [{ type: "text", text: "advisor text" }] },
  });

  toolContext = makeToolContext({ sessionID });
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 1/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute rolls back when prompt body construction fails before prompt submission", async () => {
  const rawToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const badWorktree = {
    toString() {
      throw new Error(`workspace exploded token=${rawToken}`);
    },
  };
  const { hooks, calls } = await makeHooks();
  const sessionID = nextSession("prompt-body-failure");

  let toolContext = makeToolContext({ sessionID, worktree: badWorktree });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /workspace exploded/);
  assert.ok(result.includes("token=[REDACTED]"));
  assert.ok(!result.includes(rawToken));
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.abort.length, 1);
  assert.deepStrictEqual(calls.abort[0], {
    path: { id: "child-session" },
    query: { directory: toolContext.directory },
  });

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID);
});

test("advisor execute rolls back when prompt throws before returning a promise", async () => {
  let promptThrows = true;
  const { hooks } = await makeHooks({
    promptRaw: () => {
      if (promptThrows) throw new Error("sync prompt transport");
      return { data: { info: {}, parts: [{ type: "text", text: "advisor text" }] } };
    },
  });
  const sessionID = nextSession("prompt-sync-throw");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /sync prompt transport/);
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 1/${MAX_CALLS_PER_SESSION}`);

  promptThrows = false;
  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID);
});

test("advisor execute handles rejected prompt promises without rolling back spent budget", async () => {
  let promptReject = true;
  const { hooks } = await makeHooks({
    prompt: async () => {
      if (promptReject) throw new Error("transport prompt");
      return { data: { info: {}, parts: [{ type: "text", text: "advisor text" }] } };
    },
  });
  const sessionID = nextSession("prompt-throw");

  let toolContext = makeToolContext({ sessionID });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /transport prompt/);
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 1/${MAX_CALLS_PER_SESSION}`);

  promptReject = false;
  toolContext = makeToolContext({ sessionID });
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 2/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute handles malformed prompt envelopes without rolling back spent budget", async () => {
  const promptResponses = [
    undefined,
    null,
    "bad payload",
    { data: { info: {}, parts: [{ type: "text", text: "advisor text" }] } },
  ];
  const { hooks } = await makeHooks({
    prompt: async () => promptResponses.shift(),
  });
  const sessionID = nextSession("prompt-malformed");

  for (let expectedCount = 1; expectedCount <= 3; expectedCount += 1) {
    const toolContext = makeToolContext({ sessionID });
    const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
    assert.match(result, /prompt returned no result/i);
    assert.equal(toolContext.metadataCalls[0].title, `Advisor ${expectedCount}/${MAX_CALLS_PER_SESSION}`);
  }

  const toolContext = makeToolContext({ sessionID });
  const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 4/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute keeps budget spent for post-prompt fallback result branches", async () => {
  const promptResponses = [
    { error: { name: "PromptError", message: "bad prompt" } },
    { data: { info: { error: { message: "assistant failed" } }, parts: [] } },
    { data: { info: { finish: "stop" }, parts: [] } },
    { data: { info: {}, parts: [{ type: "text", text: "advisor text" }] } },
  ];
  const { hooks } = await makeHooks({
    prompt: async () => promptResponses.shift(),
  });
  const sessionID = nextSession("post-prompt-budget");

  for (const [index, pattern] of [/bad prompt/i, /assistant failed/i, /returned no text/i].entries()) {
    const toolContext = makeToolContext({ sessionID });
    const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
    assert.match(result, pattern);
    assert.equal(toolContext.metadataCalls[0].title, `Advisor ${index + 1}/${MAX_CALLS_PER_SESSION}`);
  }

  const toolContext = makeToolContext({ sessionID });
  const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 4/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute treats metadata callbacks as optional and non-critical", async () => {
  const { hooks, calls } = await makeHooks();
  const sessionID = nextSession("metadata-optional");

  let toolContext = makeToolContext({ sessionID });
  toolContext.metadata = () => {
    throw new Error("metadata failed");
  };
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(calls.prompt.length, 1);

  toolContext = makeToolContext({ sessionID });
  delete toolContext.metadata;
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(calls.prompt.length, 2);

  toolContext = makeToolContext({ sessionID });
  result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 3/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute treats rejected metadata promises as optional and non-critical", async () => {
  const { hooks, calls } = await makeHooks();
  const sessionID = nextSession("metadata-rejects");
  const unhandled = [];
  const onUnhandled = (error) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const toolContext = makeToolContext({ sessionID });
    toolContext.metadata = () => Promise.reject(new Error("metadata async failed"));

    const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result, "advisor text");
    assert.equal(calls.prompt.length, 1);
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("advisor execute rolls back when abort listener registration throws", async () => {
  const rawToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error(`listener failed token=${rawToken}`);
    },
    removeEventListener() {
      assert.fail("removeEventListener should not run when registration fails");
    },
  };
  const { hooks, calls } = await makeHooks();
  const sessionID = nextSession("abort-listener-throws");

  const toolContext = makeToolContext({ sessionID, abort: signal });
  const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);

  assert.match(result, /listener failed/);
  assert.ok(result.includes("token=[REDACTED]"));
  assert.ok(!result.includes(rawToken));
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: makeAbortSignalStub(),
  });
  assert.equal(calls.prompt.length, 1);
});

test("advisor execute handles synchronous abort while registering the abort listener", async () => {
  const signal = makeAbortSignalStub({ abortOnAdd: true });
  const { hooks, calls } = await makeHooks();
  const sessionID = nextSession("abort-on-listener-add");

  let toolContext = makeToolContext({ sessionID, abort: signal });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);

  assert.match(result, /aborted/i);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.abort.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);
  assert.equal(signal.removed.length, 1);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: makeAbortSignalStub(),
  });
});

test("advisor execute handles an already-aborted parent signal before transcript reads", async () => {
  const controller = new AbortController();
  controller.abort();
  const { hooks, calls } = await makeHooks();
  const sessionID = nextSession("already-aborted");

  let toolContext = makeToolContext({ sessionID, abort: controller.signal });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);

  assert.match(result, /aborted/i);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.abort.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: new AbortController().signal,
  });
});

test("advisor execute aborts after transcript retrieval before child creation", async () => {
  const controller = new AbortController();
  let messagesCount = 0;
  const { hooks, calls } = await makeHooks({
    messages: async () => {
      messagesCount += 1;
      if (messagesCount === 1) controller.abort();
      return { data: [] };
    },
  });
  const sessionID = nextSession("abort-after-messages");

  let toolContext = makeToolContext({ sessionID, abort: controller.signal });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);

  assert.match(result, /aborted/i);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.abort.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: new AbortController().signal,
  });
  assert.equal(calls.messages.length, 2);
  assert.equal(calls.prompt.length, 1);
});

test("advisor execute aborts during transcript fetch and rolls back budget", async () => {
  const controller = new AbortController();
  const messagesStarted = Promise.withResolvers();
  const hangingMessages = Promise.withResolvers();
  let messagesCount = 0;
  const { hooks, calls } = await makeHooks({
    messages: async () => {
      messagesCount += 1;
      if (messagesCount === 1) {
        messagesStarted.resolve();
        return await hangingMessages.promise;
      }
      return { data: [] };
    },
  });
  const sessionID = nextSession("abort-during-messages");

  let toolContext = makeToolContext({ sessionID, abort: controller.signal });
  const resultPromise = hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  await messagesStarted.promise;

  controller.abort();
  const timeout = Symbol("timeout");
  const resultOrTimeout = await Promise.race([
    resultPromise,
    delay(50, timeout),
  ]);

  assert.notEqual(resultOrTimeout, timeout);
  assert.match(resultOrTimeout, /aborted/i);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: new AbortController().signal,
  });
});

test("advisor execute aborts during child creation and rolls back budget", async () => {
  const controller = new AbortController();
  const createStarted = Promise.withResolvers();
  const hangingCreate = Promise.withResolvers();
  let createCount = 0;
  const { hooks, calls } = await makeHooks({
    create: async () => {
      createCount += 1;
      if (createCount === 1) {
        createStarted.resolve();
        return await hangingCreate.promise;
      }
      return { data: { id: "child-session" } };
    },
  });
  const sessionID = nextSession("abort-during-create");

  let toolContext = makeToolContext({ sessionID, abort: controller.signal });
  const resultPromise = hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  await createStarted.promise;

  controller.abort();
  const timeout = Symbol("timeout");
  const resultOrTimeout = await Promise.race([
    resultPromise,
    delay(50, timeout),
  ]);

  assert.notEqual(resultOrTimeout, timeout);
  assert.match(resultOrTimeout, /aborted/i);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: new AbortController().signal,
  });
});

test("advisor execute aborts child and rolls back budget when parent aborts before prompt", async () => {
  const controller = new AbortController();
  let createCount = 0;
  const { hooks, calls } = await makeHooks({
    create: async () => {
      createCount += 1;
      if (createCount === 1) controller.abort();
      return { data: { id: `child-${createCount}` } };
    },
  });
  const sessionID = nextSession("abort-before-prompt");

  let toolContext = makeToolContext({ sessionID, abort: controller.signal });
  let result = await hooks.tool.advisor.execute(
    { question: "Advice?" },
    toolContext,
  );

  assert.match(result, /aborted/i);
  assert.equal(calls.abort.length, 1);
  assert.deepStrictEqual(calls.abort[0].path, { id: "child-1" });
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: new AbortController().signal,
  });
  assert.equal(calls.prompt.length, 1);
});

test("advisor execute does not wait for best-effort child abort before prompt", async () => {
  const controller = new AbortController();
  const neverAbort = Promise.withResolvers();
  const { hooks, calls } = await makeHooks({
    create: async () => {
      controller.abort();
      return { data: { id: "child-hanging-abort" } };
    },
    abort: async () => neverAbort.promise,
  });
  const sessionID = nextSession("abort-before-prompt-hang");

  let toolContext = makeToolContext({ sessionID, abort: controller.signal });
  const resultPromise = hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  const timeout = Symbol("timeout");
  const resultOrTimeout = await Promise.race([
    resultPromise,
    delay(50, timeout),
  ]);

  assert.notEqual(resultOrTimeout, timeout);
  assert.match(resultOrTimeout, /aborted/i);
  assert.equal(calls.abort.length, 1);
  assert.equal(calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: new AbortController().signal,
  });
});

test("advisor execute tolerates rejected and missing child abort before prompt", async () => {
  const rejectingController = new AbortController();
  const rejectingCase = await makeHooks({
    create: async () => {
      rejectingController.abort();
      return { data: { id: "child-rejecting-abort" } };
    },
    abort: async () => {
      throw new Error("abort transport failed");
    },
  });
  const rejectSession = nextSession("abort-rejects");

  let toolContext = makeToolContext({ sessionID: rejectSession, abort: rejectingController.signal });
  let result = await rejectingCase.hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /aborted/i);
  assert.equal(rejectingCase.calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(rejectingCase.hooks, rejectSession, {
    abort: new AbortController().signal,
  });

  const missingController = new AbortController();
  const missingCase = await makeHooks({
    abortMissing: true,
    create: async () => {
      missingController.abort();
      return { data: { id: "child-missing-abort" } };
    },
  });
  const missingSession = nextSession("abort-missing");

  toolContext = makeToolContext({ sessionID: missingSession, abort: missingController.signal });
  result = await missingCase.hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /aborted/i);
  assert.equal(missingCase.calls.abort.length, 0);
  assert.equal(missingCase.calls.prompt.length, 0);
  assert.equal(toolContext.metadataCalls.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(missingCase.hooks, missingSession, {
    abort: new AbortController().signal,
  });
});

test("advisor execute uses v2 session abort request shape before prompt", async () => {
  const controller = new AbortController();
  const { hooks, calls } = await makeHooks({
    sessionShape: "v2",
    create: async () => {
      controller.abort();
      return { data: { id: "child-v2-abort" } };
    },
  });
  const sessionID = nextSession("v2-abort");

  let toolContext = makeToolContext({ sessionID, abort: controller.signal });
  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.match(result, /aborted/i);
  assert.deepStrictEqual(calls.abort[0], {
    sessionID: "child-v2-abort",
    directory: toolContext.directory,
  });
  assert.equal(calls.prompt.length, 0);

  await assertNextConsultationStartsAtFirstBudgetCall(hooks, sessionID, {
    abort: new AbortController().signal,
  });
});

test("advisor execute waits briefly for in-flight prompt abort cleanup", async () => {
  const signal = makeAbortSignalStub();
  const promptStarted = Promise.withResolvers();
  const releasePrompt = Promise.withResolvers();
  let promptCount = 0;
  const { hooks, calls } = await makeHooks({
    prompt: async () => {
      promptCount += 1;
      if (promptCount === 1) {
        promptStarted.resolve();
        return await releasePrompt.promise;
      }
      return { data: { info: {}, parts: [{ type: "text", text: "advisor text" }] } };
    },
  });
  const sessionID = nextSession("abort-in-flight");

  let toolContext = makeToolContext({ sessionID, abort: signal });
  const resultPromise = hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  await promptStarted.promise;

  let settled = false;
  resultPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  signal.abort();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  releasePrompt.resolve({ data: { info: {}, parts: [{ type: "text", text: "late advisor text" }] } });
  const resultOrTimeout = await resultPromise;

  assert.match(resultOrTimeout, /aborted/i);
  assert.equal(calls.abort.length, 1);
  assert.deepStrictEqual(calls.abort[0].path, { id: "child-session" });
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 1/${MAX_CALLS_PER_SESSION}`);
  assert.equal(signal.added.length, 1);
  assert.equal(signal.removed.length, 1);
  assert.equal(signal.removed[0].listener, signal.added[0].listener);

  toolContext = makeToolContext({ sessionID, abort: new AbortController().signal });
  const result = await hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  assert.equal(result, "advisor text");
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 2/${MAX_CALLS_PER_SESSION}`);
});

test("advisor execute returns after abort cleanup timeout when prompt never settles", async () => {
  const controller = new AbortController();
  const promptStarted = Promise.withResolvers();
  const hangingPrompt = Promise.withResolvers();
  const { hooks, calls } = await makeHooks({
    prompt: async () => {
      promptStarted.resolve();
      return await hangingPrompt.promise;
    },
  });
  const sessionID = nextSession("abort-in-flight-timeout");

  const toolContext = makeToolContext({ sessionID, abort: controller.signal });
  const resultPromise = hooks.tool.advisor.execute({ question: "Advice?" }, toolContext);
  await promptStarted.promise;

  controller.abort();
  const timeout = Symbol("timeout");
  const resultOrTimeout = await Promise.race([
    resultPromise,
    delay(200, timeout),
  ]);

  assert.notEqual(resultOrTimeout, timeout);
  assert.match(resultOrTimeout, /aborted/i);
  assert.equal(calls.abort.length, 1);
  assert.equal(toolContext.metadataCalls[0].title, `Advisor 1/${MAX_CALLS_PER_SESSION}`);
  assert.equal(toolContext.metadataCalls[1].title, "Advisor abort cleanup timed out");
  assert.deepStrictEqual(toolContext.metadataCalls[1].metadata, {
    advisorAbortCleanupTimedOut: true,
  });
});

test("advisor execute cleans up abort listeners on success and prompt failure", async () => {
  let promptReject = false;
  const { hooks } = await makeHooks({
    prompt: async () => {
      if (promptReject) throw new Error("transport prompt");
      return { data: { info: {}, parts: [{ type: "text", text: "advisor text" }] } };
    },
  });
  const assertAbortListenerCleanup = (signal) => {
    assert.equal(signal.added.length, 1);
    assert.equal(signal.added[0].type, "abort");
    assert.deepStrictEqual(signal.added[0].options, { once: true });
    assert.equal(signal.removed.length, 1);
    assert.equal(signal.removed[0].type, "abort");
    assert.equal(signal.removed[0].listener, signal.added[0].listener);
  };

  let signal = makeAbortSignalStub();
  let result = await hooks.tool.advisor.execute(
    { question: "Advice?" },
    makeToolContext({ abort: signal }),
  );
  assert.equal(result, "advisor text");
  assertAbortListenerCleanup(signal);

  promptReject = true;
  signal = makeAbortSignalStub();
  result = await hooks.tool.advisor.execute(
    { question: "Advice?" },
    makeToolContext({ abort: signal }),
  );
  assert.match(result, /transport prompt/);
  assertAbortListenerCleanup(signal);

  promptReject = false;
  signal = makeAbortSignalStub({ removeThrows: true });
  result = await hooks.tool.advisor.execute(
    { question: "Advice?" },
    makeToolContext({ abort: signal }),
  );
  assert.equal(result, "advisor text");
  assertAbortListenerCleanup(signal);
});

test("advisor execute returns fallback text for prompt errors, assistant errors, and no text", async () => {
  const responses = [
    { error: { name: "PromptError", message: "bad prompt password=hunter2" } },
    { data: { info: { error: { message: "assistant failed token=ghp_abcdefghijklmnopqrstuvwxyz123456" } }, parts: [] } },
    { data: { info: { finish: "stop" }, parts: [{ type: "tool", output: "no text" }] } },
    { data: { info: { finish: "unknown" }, parts: null } },
  ];
  const { hooks } = await makeHooks({ prompt: async () => responses.shift() });

  let result = await hooks.tool.advisor.execute({ question: "Advice?" }, makeToolContext());
  assert.match(result, /PromptError: bad prompt/);
  assert.ok(result.includes("password=[REDACTED]"));
  assert.ok(!result.includes("hunter2"));

  result = await hooks.tool.advisor.execute({ question: "Advice?" }, makeToolContext());
  assert.match(result, /assistant failed/);
  assert.ok(result.includes("token=[REDACTED]"));
  assert.ok(!result.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"));

  result = await hooks.tool.advisor.execute({ question: "Advice?" }, makeToolContext());
  assert.match(result, /returned no text/);
  assert.match(result, /parts: tool/);
  assert.match(result, /finish: stop/);

  result = await hooks.tool.advisor.execute({ question: "Advice?" }, makeToolContext());
  assert.match(result, /returned no text/);
  assert.match(result, /parts: none/);
  assert.match(result, /finish: unknown/);
});

test("advisor execute redacts credential-like advisor response text", async () => {
  const { hooks } = await makeHooks({
    prompt: async () => ({
      data: { info: {}, parts: [{ type: "text", text: "Use password=hunter2 and sk-12345678901234567890" }] },
    }),
  });

  const result = await hooks.tool.advisor.execute({ question: "Advice?" }, makeToolContext());

  assert.ok(result.includes("password=[REDACTED]"));
  assert.ok(result.includes("[REDACTED TOKEN]"));
  assert.ok(!result.includes("hunter2"));
  assert.ok(!result.includes("sk-12345678901234567890"));
});
