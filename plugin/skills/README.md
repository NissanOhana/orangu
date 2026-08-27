# Orangu skills

Five Claude Code skills; each owns one job and routes the rest to a sibling.

| Skill | What it is | Use instead when |
|---|---|---|
| `/orangu:analyze` | Explain one session, finished or live: outcome, steps, errors, time, tokens; open its report | you want a change proposed: `/orangu:improve`; your setup reviewed: `/orangu:harness` |
| `/orangu:improve` | Turn one finding into one bounded proposal with evidence, expected effect, risk, and a verification check; never edits the repository | you want it applied: `/orangu:apply` |
| `/orangu:apply` | Apply one reviewed proposal, run the repository's own checks, record a receipt | it still needs drafting: `/orangu:improve` |
| `/orangu:harness` | Review declared vs used harness configuration across a repository or every session; propose ranked changes | it is about one session: `/orangu:analyze` |
| `/orangu:feedback` | Send beta feedback about Orangu itself from a private localhost form | it is about a session: `/orangu:analyze` |

Skills read `orangu` CLI output, never a `.jsonl` transcript, and size each read first. Tokens, milliseconds and effort are the only units.

`plugins/orangu/skills/` and `.agents/skills/` mirror `improve`, `apply`, and `feedback` for Codex as `$orangu-<name>`; edit here, not there.
