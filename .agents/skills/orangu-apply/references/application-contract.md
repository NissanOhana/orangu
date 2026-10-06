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

- `id` must match the filename and the proposal id.
- `files` contains 1-64 relative repository paths that you changed. It has no absolute path, `.`, `..`, `.git` or duplicate.
- `checks` contains 1-32 checks that you ran. Every `ok` is literally `true`.
- Do not include a failed, skipped, inferred or user-reported check as successful.
- This receipt is skill-authored: a statement of the files changed and the checks run. Orangu validates its schema and its exact agreement with the reviewed relative file list. Orangu does not inspect the working-tree diff, run a command itself, or prove filesystem confinement.
- The apply skill contract has two requirements: stay inside the reviewed files, and record only the checks that ran successfully. This receipt is not a later-session verification receipt.
- Session-scope and repo-scope applications may later be verified against later sessions from the same canonical workspace. Orangu selects those sessions itself. Global-scope proposals cannot be applied.
