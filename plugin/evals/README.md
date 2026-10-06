# Orangu plugin evals

`claude plugin eval` (Claude Code 2.1.269 or newer) runs each case here as a fresh non-interactive session with only this plugin loaded, three times with the plugin and three times without it. The difference between the two arms is what the skill text contributes, and the report shows it per case.

## What the suite grades

- **Routing.** A natural request fires the one skill that owns it (`analyze`, `improve`, `harness`, `show-me`, `feedback`), and an unrelated request fires none. The `tool_used: Skill` grader is the plugin-fired indicator; in a two-arm run it is reported, not scored. `apply` is invoked by its slash form, which expands the skill inline with no Skill call, so its case proves the skill ran by what only the skill knows: it demands an `sg_` id.
- **The transcript boundary.** A `.jsonl` is placed within reach and the prompt asks for it directly; a skill must route through `orangu`, never `Read` or `Grep` the file. Graded in both arms, so the baseline shows the difference, and a run that never reached the file fails its rubric instead of passing by default.
- **Honesty.** Runs grant no `Bash`, so the bundled CLI never executes. A skill that cannot run `orangu` must say so and report no figures, no saved proposal, and no applied change. The CLI itself is covered by `npm test`.
- **Safety.** `apply` without an id stops before any project read and demands an `sg_` id. That a run cannot edit at all comes from the tool allowlist, not from the skill, so no grader claims it.

## Run it

```bash
npm run eval:plugin                                                   # every case, both arms, local report
claude plugin eval ./plugin --case <name> --runs 1 --ablation none    # one case, one arm, while iterating
```

Each run is a batch of model calls on your own account. Results land in `plugin/evals/results/<timestamp>/` (ignored by git) as `aggregate-result.json` and a self-contained `report.html`. On demand, `.github/workflows/plugin-evals.yml` runs the suite with both models pinned, a spend ceiling, and the report kept local; it needs an `ANTHROPIC_API_KEY` repository secret.

## Improving the skills against this suite

Every case is tagged `train` or `holdout`. Four are held out: one routing case each for analyze, improve, and harness, and one negative.

```bash
npm run eval:plugin:train     # iterate here: read these runs, change one thing, run again
npm run eval:plugin:holdout   # run once at the end to confirm; never tune against it
```

- Change one thing per round and aim it at the cause the train runs show; never paste a failing prompt or reply into a skill.
- If train goes up while holdout stays flat, the change fit these cases rather than the skill's job: revert it.
- Headroom: when the with-plugin arm already scores 0.95 or more on most cases, the suite cannot show a quality gain. Hold the score and aim at fewer turns, or add cases whose difficulty a person can explain before anyone runs them. Do not add a case only because today's model fails it.
- Plumbing: a grader that threw, or a run that stopped on a usage limit or a timeout, is not a skill failure. Re-run it before reading the score.
- Graders: read a sample of graded runs before trusting a score. A case that fails every run whatever the skill says usually has an ambiguous prompt or a grader that asks for something the prompt never stated.

## Add a case

One directory per case: `prompt.md` (frontmatter for limits, `allowed_tools`, and a `train` or `holdout` tag, a body phrased the way a person types, never the skill name) and `graders/*.md`, one grader on the result and one on the path Claude took. Keep `llm` rubrics to concrete PASS and FAIL lines, and prefer `regex` and `tool_used`, which are free and stable. `npm test -- test/plugin-evals` checks the shape offline.

## Not covered here

Exercising the CLI inside a run needs an operator grant that names the CLI file before its `*`, such as `--allow-tools "Bash(node <plugin-root>/bin/orangu.cli.mjs *)"`, the OS sandbox, and a `scaffold_script` that writes a synthetic transcript into the workspace. Those flags widen what a run can do, so they stay out of the default suite and the workflow.
