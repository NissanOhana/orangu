# Documentation

Everything committed here is public product or contributor documentation. Local planning, research, run logs, and agent-management notes are intentionally excluded from Git.

## Use Orangu

- [Usage](USAGE.md): commands, report and localhost app surfaces, accepted inputs, and resource limits.
- [Privacy](PRIVACY.md): what stays local, what redaction removes, and what to check before sharing.
- [Beta feedback](feedback.md): private localhost drafting, exact-review consent, and the GitHub handoff.
- [Determinism and AI skills](DETERMINISM.md): which layer owns evidence, proposals, application, and verification.

## Integrate and extend

- [Architecture](ARCHITECTURE.md): pipeline, module ownership, build, and correctness gates.
- [Data contracts](DATA-CONTRACTS.md): Analysis, EvidenceBundle, AppData, suggestion, proposal, application, and verification shapes.
- [Design system](DESIGN.md): visual tokens, interaction rules, accessibility, and brand assets.
- [Claude Code analysis shape](../plugin/skills/orangu-analyze/references/json-shape.md): field-level Analysis and Aggregate reference.

## Contribute and report issues

- [Contributing](../CONTRIBUTING.md): repository layout, tests, and pull-request expectations.
- [Beta feedback issue form](../.github/ISSUE_TEMPLATE/beta-feedback.yml): the public fallback intake fields and privacy acknowledgement.
- [Security](../SECURITY.md): private vulnerability reporting and safe transcript handling.

The shipped workflow instructions live under [`plugin/skills/`](../plugin/skills/) for Claude Code and [`.agents/skills/`](../.agents/skills/) for Codex. They are executable product surfaces, not maintainer prompts.
