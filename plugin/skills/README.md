# Orangu skills

Six Claude Code skills. Each owns one job and routes the rest.

| Skill | What it is | Use instead when |
|---|---|---|
| `/orangu:analyze` | Explain one session (`current` included), finished or live: outcome, steps, errors, time, tokens. Open its report | you want a change proposed: `/orangu:improve`. Your setup reviewed: `/orangu:harness` |
| `/orangu:improve` | Turn one finding into one bounded proposal with evidence, expected effect, risk, and a verification check. Never edits the repository | you want it applied: `/orangu:apply` |
| `/orangu:apply` | Apply one reviewed proposal, run the repository's own checks, record a receipt | it still needs drafting: `/orangu:improve` |
| `/orangu:harness` | Review declared vs used harness configuration repo-wide or machine-wide, interview you, propose changes, apply approved ones | it is about one session: `/orangu:analyze` |
| `/orangu:show-me` | Write a slide deck and a written report from the evidence, as offline HTML | you want a diagnosis in chat: `/orangu:analyze` |
| `/orangu:feedback` | Send beta feedback about Orangu itself from a private localhost form | it is about a session: `/orangu:analyze` |

Skills read `orangu` CLI output, never a `.jsonl` transcript, and size each read first. Units: tokens, milliseconds, effort.

The build generates Codex mirrors of `improve`, `apply`, `feedback` (`$orangu-<name>` under `plugins/orangu/skills/` and `.agents/skills/`). `analyze`/`harness` pointers become CLI verbs. Edit only here.
