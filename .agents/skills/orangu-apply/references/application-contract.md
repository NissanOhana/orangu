# Orangu application receipt

Write `~/.orangu/proposals/<id>.applied.json` only after every required local check passes:

```json
{
  "v": 1,
  "id": "sg_000000000000",
  "summary": "What was changed locally",
  "files": ["relative/file.md"],
  "checks": [
    { "name": "Focused test", "command": "npm test -- path/to/test", "ok": true },
    { "name": "Diff validation", "command": "git diff --check", "ok": true }
  ]
}
```

The id matches the filename and proposal. Files are 1-64 unique relative paths actually changed; never absolute, `.`, `..`, or `.git`. Checks are 1-32 commands actually run successfully, each with literal `ok: true`. Never record a failed, skipped, inferred, or user-reported check as successful.

This receipt is a skill-authored attestation. Orangu validates its schema and exact agreement with the reviewed relative file list; it does not inspect the working-tree diff, independently run a command, or prove filesystem confinement. Staying inside reviewed files and reporting checks truthfully are required by the apply skill contract. The receipt is not later-session verification.

Session-scope applications may later be verified against a discoverable supported session from the same canonical workspace. Repo-scope applications remain `applied` until a real fresh-cohort comparator exists. Global-scope proposals cannot be applied.
