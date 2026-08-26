# Proposal file format

Write one reviewable file at `~/.orangu/proposals/<id>.md`. Keep it bounded. Evidence carries the argument.

```markdown
# <one-line title>

- **Suggestion**: <sg_id> | rule `<ruleId>` | scope <session|repo|global>
- **Change class**: <instruction|script-cli|hook|skill-create|skill-discover|subagent-agent|mcp|plugin|workflow-config>
- **Evidence sessions**: <id>, <id>
- **Effort**: S | M | L
- **Expected effect**: <named quality outcome, measured tokens, or milliseconds; mark estimates>
- **Catalog evidence**: <catalog: id, or none>

## The change

<A concrete, diff-shaped proposal. Name the target file or extension surface. Do not apply it.>

## Evidence

<The exact finding, crosswalk row, counts, and example sessions from deterministic output. Do not invent a number.>

## Expected effect

<What should change in the next run. Use a qualitative quality outcome when no measured token or millisecond estimate exists.>

## Risks and limits

<What could regress, what this proposal does not address, and why this is the smallest fitting class.>

## Verification

<The exact deterministic command and named field or outcome to compare after the user applies the change. A proposal does not verify itself.>
```

For `skill-discover`, add a **Candidate review** section with the user-run search query, source, install count as observed by the user, repository evidence, and `verifiedAt: null`. Never claim installation and never place an encoded finding or other handoff secret in the proposal. This file describes the legacy Markdown compatibility shape; new proposals use the structured artifact contract.
