# Orangu skills

Five Claude Code skills. Start with `/orangu:improve`. Run `/orangu:interview` to tell orangu your role and your work.

Claude starts the other 3.

| Skill | What it is | Use instead when |
|---|---|---|
| `/orangu:improve` | Find patterns in one session or the whole harness, propose ranked changes, and apply the ones you approve by id. It offers the interview on its first run | you want to change your answers: `/orangu:interview` |
| `/orangu:interview` | Ask about your role and your work, and keep your answers as your profile | you want a change proposed: `/orangu:improve` |
| `/orangu:apply` | Apply one reviewed proposal, run the repository's own checks, record a receipt | it needs drafting: `/orangu:improve` |
| `/orangu:show-me` | Write a slide deck and a written report from the evidence, as offline HTML | you want a diagnosis: `/orangu:improve` |
| `/orangu:feedback` | Send beta feedback about Orangu from a private localhost form | it is about a session: `/orangu:improve` |

Skills read `orangu` CLI output, never a `.jsonl` transcript, and size each read first. Units: tokens, milliseconds, effort.

The build mirrors `improve`, `apply`, `feedback`, `interview` to Codex (`$orangu-<name>` under `plugins/orangu/skills/` and `.agents/skills/`). Edit only here.
