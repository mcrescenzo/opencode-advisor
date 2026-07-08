# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses semantic versioning for published package releases.

## [0.1.1] - 2026-07-08

### Changed

- Documentation-only release: restructured the README for human readers with a
  value-led introduction, a consolidated Quick Start, and a concrete worked
  example of an `advisor` call.
- Relocated the full security model to `docs/security-model.md` and the hooks
  table to `docs/internals.md`; moved contributor and release detail to
  `CONTRIBUTING.md`. No runtime changes.

## [0.1.0] - 2026-07-07

### Added

- Initial `advisor` OpenCode plugin package.
- Hidden `advisor-strategist` child-session agent for strategic review.
- Budgeted `advisor` tool with transcript curation and best-effort redaction.
- Hardened read-only permission defaults and mocked plugin regression tests.
- Public package metadata, MIT license, dependency license inventory, security
  reporting policy, and CI test gate.
