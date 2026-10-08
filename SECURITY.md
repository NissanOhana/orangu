# Security policy

## Report a vulnerability privately

Do not open a public issue for a vulnerability or attach a real session transcript, report, suggestion store, credential, customer name, or private path.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/NissanOhana/orangu/security/advisories/new>

Include the affected command or surface, the smallest synthetic reproduction you can provide, expected and observed behavior, and impact. Replace real secrets and session content with obvious test values.

## Supported versions

Security fixes target the latest release and the current `main` branch.

## Security boundaries

- Generated reports are self-contained and deny network access through Content Security Policy.
- The live app binds to loopback and rejects untrusted browser mutations.
- Shareable output is redacted by default, but users must still review exports before publishing them.
- Orangu replaces a file that `-o`, `--out` or `--html` names only when the file starts with the marker that orangu writes. Inside Claude Code, unredacted text goes to a named file only with `ORANGU_ALLOW_RAW=1` before the command, so that Claude Code asks first.
- Improvement skills consume bounded redacted evidence. Raw transcripts are not model inputs.
- Each plugin skill pre-approves by name each `orangu` verb that it runs, and no other `orangu` verb. `analyze`, `improve`, `harness` and `apply` check chat text from a draft file under `~/.orangu/drafts/`, never through the shell.
- `/orangu:show-me` writes only 3 text values. Orangu redacts them, writes them as text, and checks each HTML file against its template before it writes it.
- Applying a proposal requires separate explicit invocation and repository binding. `/orangu:apply` pre-approves no edit and no project check.

See [the privacy model](docs/PRIVACY.md) for output and research boundaries.
