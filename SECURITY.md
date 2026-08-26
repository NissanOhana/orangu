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
- Improvement skills consume bounded redacted evidence; raw transcripts are not model inputs.
- Applying a proposal requires separate explicit invocation and repository binding.

See [the privacy model](docs/PRIVACY.md) for output and research boundaries.
