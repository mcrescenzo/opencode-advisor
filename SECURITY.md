# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately using [GitHub security
advisories](https://github.com/mcrescenzo/opencode-advisor/security/advisories/new)
on this repository. Do not open a public issue for a suspected vulnerability.

If you cannot use GitHub security advisories, you may instead email
`michaelcrescenzo@gmail.com` with the subject prefix `[opencode-advisor
security]`.

Include:

- the `@mcrescenzo/opencode-advisor` version;
- your opencode version;
- the affected surface, such as permissions, child-session isolation, secret
  redaction, or network/tool exposure;
- reproduction steps or a minimal config when possible; and
- any logs or advisor output with secrets redacted.

Do not open a public GitHub issue for an unpatched vulnerability. Public issues
are appropriate for ordinary bugs and feature requests after sensitive details
have been removed.

Do **not** include live secrets, credentials, private logs, or private
workspace data in a report — redact them first, over either channel.

## Supported Versions

The current pre-1.0 release line receives security fixes. Older unpublished or
pre-release snapshots are not supported once a newer package version is
available.
