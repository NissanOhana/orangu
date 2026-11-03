<div align="center">

<img src="https://raw.githubusercontent.com/NissanOhana/orangu/main/design/brand/mascot-main-transparent.png" width="120" alt="orangu" />

# orangu

**Improve your agent harness and your setup.**

Measure every agent session. Keep the changes that work.

[sample report](https://nissanohana.github.io/orangu/sample.html) · [docs](docs/README.md) · [npm](https://www.npmjs.com/package/orangu) · `npx orangu`

</div>

orangu helps you get better results with fewer tokens. It reads every Claude Code, Cowork and Desktop session on your disk, with each agent tree. It measures with plain code, not a model, and it makes no network calls. The brain proposes changes that fit your role. Then orangu checks each applied change on your later sessions.

## Start

```bash
npx orangu
```

The command prints a summary of your latest session and its top finding. On a terminal, it then opens the local app. Press ctrl-c to stop the app. In a pipe or in CI, it prints only the summary. orangu needs Node.js 20 or newer.

Then add the brain to Claude Code:

```text
/plugin marketplace add NissanOhana/orangu
/plugin install orangu
/orangu:improve
```

## How it works

1. **See.** `npx orangu` reads every session on your disk, each agent tree included. The app shows one session, your sessions and their agents, or the whole machine. 44 deterministic rules find the first improvements.
2. **Improve.** `/orangu:improve` is the brain. It finds patterns in the evidence and in your harness. It proposes ranked changes: a skill, an agent, the effort or the model, a CLI or a script, or a hook. It applies only the changes that you approve by id.
3. **Tune.** The first run of `/orangu:improve` offers an interview about your role and your work. Your answers become your orangu profile, and the brain ranks each later proposal with them. Run `/orangu:interview` at any time to change them.

orangu marks a change verified only when your later sessions in the same workspace beat the earlier sessions beyond chance. The check does not prove that the change caused the difference. orangu never changes your harness by itself. A change to the whole machine stays a proposal.

## Outside Claude Code

The brain also runs in claude.ai, Claude Desktop and the Claude API. Run `npx orangu export`. It writes 2 files: the skill `orangu-improve.zip` and your redacted evidence `orangu-export.json`. Upload the skill once. Add the evidence to a chat after you review it. In those hosts, the brain only proposes changes, and it cannot apply or check them.

Codex can run the brain too. Install it with `codex plugin marketplace add NissanOhana/orangu` and `codex plugin add orangu@orangu`. Then run `$orangu-improve` in Codex. orangu does not read Codex transcripts.

## Promises

- **No model in the measurement.** Plain code counts, compares and ranks.
- **No network.** Reports make no request. The app binds to `127.0.0.1` behind a private link.
- **Redacted by default.** orangu scrubs secrets. Shareable output leaves out prompt text unless you ask for it with `--include-text`.
- **Same transcript in, byte-identical analysis out.**
- **Tokens only, and no single score.** orangu counts tokens and never converts them into another unit. Quality, time and tokens stay separate, and orangu never ranks people.

## Documentation

[Usage](docs/USAGE.md) · [Determinism](docs/DETERMINISM.md) · [Privacy](docs/PRIVACY.md) · [Data contracts](docs/DATA-CONTRACTS.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [llms.txt](https://nissanohana.github.io/orangu/llms.txt)

## Develop

```bash
git clone https://github.com/NissanOhana/orangu && cd orangu
npm ci && npm run verify:release
```

## License

MIT © Nissan Ohana. The mascot is CC0.

<div align="center"><sub>orangu is not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. Codex is a product of OpenAI.</sub></div>
