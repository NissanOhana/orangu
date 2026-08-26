# The deterministic L2 catalog

`orangu suggest --show <id> --json` returns catalog matches after the estimate gate passes.

- **L1:** deterministic findings and their measured evidence. The only source of numbers.
- **L2:** curated `catalog.json` and `features.json` entries, matched locally by `catalog.ts` with no clock or network.
- **L3:** an optional skill interprets the evidence, chooses one change class, and writes a proposal.

## Match shape

Each match is `{ entry, evidence }`:

```jsonc
{
  "entry": {
    "id": "fix-reread-files",
    "changeClass": "instruction",
    "pattern": { "ruleId": "reread-files" },
    "feature": "read-once discipline + auto memory",
    "url": "https://code.claude.com/docs/en/memory.md",
    "verifiedAt": "2026-08-23",
    "note": "why the entry applies and what boundary to preserve"
  },
  "evidence": "finding ruleId=reread-files"
}
```

The nine change classes are `instruction`, `script-cli`, `hook`, `skill-create`, `skill-discover`, `subagent-agent`, `mcp`, `plugin`, and `workflow-config`.

## Use rules

1. **Evidence before class.** A class names the surface a proposal would change. It is not proof that the change is appropriate.
2. **Catalog before outside research.** Start from matched entries and cite them as `catalog: <id>`.
3. **Verification stays explicit.** `verifiedAt` dates the catalog claim. It does not mean the proposed change worked in this harness.
4. **Discoveries stay candidates.** For `skill-discover`, give the user a specific skills.sh or `npx skills find <query>` search to run. Do not execute it or install anything. Record any result with its source and `verifiedAt: null` until curated.
5. **No runtime catalog writes.** Skills never edit the catalog files. Catalog updates happen only as reviewed release work.
