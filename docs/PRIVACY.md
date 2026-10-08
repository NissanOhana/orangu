# Privacy

Session transcripts may contain source code, secrets, customer data, prompts, paths, and tool results. Orangu is designed so observation stays local by default.

## Local surfaces

- `orangu report` writes one self-contained HTML file with a zero-network Content Security Policy.
- `orangu watch` rewrites the same local file as a session grows.
- If `-o`, `--out` or `--html` names an existing file, orangu replaces it only when the file starts with the orangu output marker. It refuses any other file, a symlink, a hard link and an empty file, and changes nothing.
- `orangu show-me` writes `data.json`, a slide deck and a written report in a new directory under `~/.orangu/show-me/`. The deck and the report have the same zero-network policy.
- `orangu serve` binds to `127.0.0.1` and requires a fresh process capability embedded in the launched URL before serving HTML, API data, exports, mutations, or events. Treat that URL as private while the process runs.
- Orangu has no telemetry and does not require an account.
- Browser suggestion actions are copy-only. The server does not launch a model process.

The public landing page is separate from a generated report. It may load allowlisted public assets, but it never receives session data.

## Redaction

Default report and JSON output:

- scrubs recognized credentials, tokens, emails, and similar sensitive strings;
- omits arbitrary prompt and result text from reports and app APIs;
- shortens the current user's home directory to `~`.

Other absolute paths can remain because they are useful evidence. Use `--strip-paths` before sharing when paths are not needed. Use `--include-text` or `--no-redact` only for an explicitly requested local inspection.

Inside Claude Code, `--no-redact` or `--include-text` with `-o`, `--out` or `--html <file>` needs `ORANGU_ALLOW_RAW=1` before the command. Text in a session can steer Claude to run a command, and this prefix makes Claude Code ask you first. Orangu reads the `CLAUDECODE` variable, and the terminal of an IDE with Claude Code can also set it.

Redaction is defense in depth, not a guarantee that arbitrary data is safe to publish. Review every exported report or JSON file before sharing it.

## AI-skill boundary

`orangu evidence` produces the bounded, always-redacted projection consumed by `orangu-improve`. The skill never opens raw JSONL directly.

Optional online research is catalog-first and uses only generic feature or change-class terms. Skill contracts prohibit placing local prompts, paths, ids, project or customer names, evidence, code, errors, or proposal text in network queries or URLs.

`orangu-apply` performs no online research. It can edit only after explicit invocation and a successful repository-binding preflight.

`/orangu:show-me` reads `data.json`, redacted by default, and writes only 3 text values. `orangu show-me --render` redacts those 3 values before it writes them into the deck and the report.

`analyze`, `improve`, `harness` and `apply` check the text that they write for you with `orangu ste`. Chat text goes to a new draft file under `~/.orangu/drafts/`, never through the shell.

## Local storage

Orangu writes cache and suggestion data under `$ORANGU_HOME`, then `$XDG_DATA_HOME/orangu`, or `~/.orangu`. These files remain local and should not be committed. `~/.orangu/drafts/` holds the checked drafts, and `~/.orangu/show-me/` holds the show-me runs. You can delete either directory at any time.

Contributor-only diagnostics under `scripts/` may print session identifiers, relative paths, client or model metadata, and error text. They do not upload data, but their output is not a share-safe artifact. Review and redact it before copying it into an issue, benchmark, or discussion.

## Before sharing

1. Keep redaction enabled.
2. Add `--strip-paths` when file locations are not necessary.
3. Do not use `--include-text` for a shareable artifact unless you reviewed every preview first.
4. Open the exported file and search for project names, customer terms, paths, emails, and credential prefixes.
5. Report a redaction or containment flaw through the private process in [SECURITY.md](../SECURITY.md).
