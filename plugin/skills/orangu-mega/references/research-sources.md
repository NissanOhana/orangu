# Outside-research policy

Read this only after the deterministic catalog has been consulted and the user has explicitly approved outside research. Pass the policy, uncovered item ids, change classes, and digest paths to `orangu:harness-researcher`.

## Nondisclosure boundary

Digest paths, item ids, project context, and proposal content are local-only inputs. Online queries and opened URLs use generic feature and change-class terms only. Never send local prompts, paths, session or suggestion ids, project/repository/customer names, digest content, proposal text, code, or local error text to a network service or place them in a URL. Join generic research results to local evidence only after returning offline.

## Provenance rule

`src/suggest/verified-urls.json` is the vendored allowlist for curated catalog claims. The researcher cannot modify it. Every newly researched result is still a candidate with its opened source URL and `verifiedAt: null`, even when the source is authoritative. A proposal is never evidence that the change worked.

## Tier 1: authoritative documentation

**Budget: at most 4 web calls.**

Use the official Claude Code or Claude platform documentation for instruction files, scripts and commands, hooks, skills, agents, MCP, plugins, settings, and workflows. Prefer the page that directly defines the extension surface. Open only pages needed for the supplied gap.

## Tier 2: maintained repositories and directories

**Budget: at most 3 web calls.**

Use maintained source repositories and focused directories for a named missing capability. For external skill discovery, a specific query at `https://skills.sh/` may identify candidates. Record source reputation, repository evidence, install count, maintenance signals, and the exact capability match. Popularity shows adoption, not correctness.

Do not run `npx skills find`, do not install anything, and do not present a search result as an endorsed change. Return a user-run query or install command only as part of candidate review.

## Tier 3: practitioner evidence

**Budget: at most 3 web calls.**

Use discussion, engineering write-ups, or issue reports only for a gap the first two tiers did not answer. One report is an anecdote. Keep it labelled as such and do not convert it into a measured effect for this harness.

## Per-run limit

Ten web calls total across the three tiers. Spend fewer when the catalog or an earlier source resolves the question. Report `callsUsed`, the candidates found, and what remained unexplored.
