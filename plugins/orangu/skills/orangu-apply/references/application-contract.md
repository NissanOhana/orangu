# Orangu application receipt

Write valid JSON to `~/.orangu/proposals/<id>.applied.json` only after the change is complete and all required local checks pass:

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

Rules:

- `id` must match the filename and proposal id.
- `files` contains 1-64 relative repository paths actually changed; no absolute path, `.`, `..`, `.git`, or duplicate.
- `checks` contains 1-32 checks actually run. Every `ok` is literally `true`.
- Do not include a failed, skipped, inferred, or user-reported check as successful.
- This receipt is skill-authored: a statement of the files changed and checks run. Orangu validates its schema and exact agreement with the reviewed relative file list; it does not inspect the working-tree diff, independently run a command, or prove filesystem confinement.
- Staying inside the reviewed files and recording only checks actually run successfully are required by the apply skill contract. This is not a later-session verification receipt.
- Session-scope applications may later be verified against a discoverable supported session from the same canonical workspace. Repo-scope applications remain `applied` until a real fresh-cohort comparator exists. Global-scope proposals cannot be applied.
