# Orangu plugin evals

`claude plugin eval` (Claude Code 2.1.269 or newer) runs each case here as a fresh non-interactive session with only this plugin loaded, three times with the plugin and three times without it. The difference between the two arms is what the skill text contributes, and the report shows it per case.

## What the suite grades

- **Routing.** A natural request fires the one skill that owns it (`analyze`, `improve`, `harness`, `feedback`), and an unrelated request fires none. The `tool_used: Skill` grader is the plugin-fired indicator; in a two-arm run it is reported, not scored. `apply` is invoked by its slash form, which expands the skill inline with no Skill call, so its case proves the skill ran by what only the skill knows: it demands an `sg_` id.
- **The transcript boundary.** A `.jsonl` is placed within reach and the prompt asks for it directly; a skill must route through `orangu`, never `Read` or `Grep` the file. Graded in both arms, so the baseline shows the difference.
- **Honesty.** Runs grant no `Bash`, so the bundled CLI never executes. A skill that cannot run `orangu` must say so and report no figures, no saved proposal, and no applied change. The CLI itself is covered by `npm test`.
- **Safety.** `apply` refuses without an `sg_` id and edits nothing.

## Run it

```bash
npm run eval:plugin                                                   # every case, both arms, local report
claude plugin eval ./plugin --case <name> --runs 1 --ablation none    # one case, one arm, while iterating
```

Each run is a batch of model calls on your own account. Results land in `plugin/evals/results/<timestamp>/` (ignored by git) as `aggregate-result.json` and a self-contained `report.html`. On demand, `.github/workflows/plugin-evals.yml` runs the suite with both models pinned, a spend ceiling, and the report kept local; it needs an `ANTHROPIC_API_KEY` repository secret.

## Add a case

One directory per case: `prompt.md` (frontmatter for limits and `allowed_tools`, a body phrased the way a person types, never the skill name) and `graders/*.md`, one grader on the result and one on the path Claude took. Keep `llm` rubrics to concrete PASS and FAIL lines, and prefer `regex` and `tool_used`, which are free and stable. `npm test -- test/plugin-evals` checks the shape offline.

## Not covered here

Exercising the CLI inside a run needs an operator grant such as `--allow-tools "Bash(node *orangu.cli.mjs*)"`, the OS sandbox, and a `scaffold_script` that writes a synthetic transcript into the workspace. Those flags widen what a run can do, so they stay out of the default suite and the workflow.
