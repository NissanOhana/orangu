# Orangu skills

Five Claude Code skills; each owns one job and routes the rest onward.

| Skill | What it is | Use instead when |
|---|---|---|
| `/orangu:analyze` | Explain one session, finished or live: outcome, steps, errors, time, tokens; open its report | you want a change proposed: `/orangu:improve`; your setup reviewed: `/orangu:harness` |
| `/orangu:improve` | Turn one finding into one bounded proposal with evidence, expected effect, risk, and a verification check; never edits the repository | you want it applied: `/orangu:apply` |
| `/orangu:apply` | Apply one reviewed proposal, run the repository's own checks, record a receipt | it still needs drafting: `/orangu:improve` |
| `/orangu:harness` | Review declared vs used harness configuration across a repository or every session; propose ranked changes | it is about one session: `/orangu:analyze` |
| `/orangu:feedback` | Send beta feedback about Orangu itself from a private localhost form | it is about a session: `/orangu:analyze` |

Skills read `orangu` CLI output, never a `.jsonl` transcript, and size each read first. Units: tokens, milliseconds, effort.

The build generates Codex mirrors of `improve`, `apply`, `feedback` (`$orangu-<name>` under `plugins/orangu/skills/` and `.agents/skills/`); `analyze`/`harness` pointers become CLI verbs. Edit here, not there.
