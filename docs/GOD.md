# orangu god

orangu god is a Claude Code mod: a plugin of function hooks. It shows each live Claude Code session of this machine in 1 pane, inside 1 god session. The pane tells you which session needs you now. From the pane, you can read a session, answer its question or send it a prompt.

orangu god is not in the plugin marketplace yet. Load it from a clone of this repository. The clone holds the built mod in `god/`.

## Load it

1. Clone this repository. In the next steps, `<repo>` is the path of your clone.
2. Start Claude Code with the mod: `claude --plugin-dir <repo>/god`.
3. Type `/god` to open the pane.

To open the pane each time you start the god session, add a `god` alias to your shell:

```sh
alias god='CLAUDE_CODE_NO_FLICKER=1 ORANGU_GOD=1 claude --plugin-dir <repo>/god'
```

`ORANGU_GOD=1` opens the pane when the session starts. `CLAUDE_CODE_NO_FLICKER=1` starts the fullscreen layout of Claude Code, where the pane docks beside the transcript. In the normal layout, the pane opens above the prompt.

Without `/god` or `ORANGU_GOD=1`, the mod only registers the `/god` command. It runs no host command, reads no file, starts no timer and opens no pane.

orangu god needs cmux for `j`, the digit answers, `r`, the Screen tab and the alert ring. The rest works without cmux.

The `/god` command takes these forms:

| Command | What it does |
|---|---|
| `/god` | It opens the pane and starts the board. |
| `/god all` | It shows every live session and clears the repo set. |
| `/god repos <name>...` | It shows only the sessions of these repos. A linked worktree counts as its repo. |
| `/god repos` | It shows the repos that the repos mode keeps. |
| `/god stats` | It shows how long the last refresh took, and the count of tones and notifications since the start. |

## The board

The board shows 1 row for each live session but the god session, and it refreshes every 2 s. A background session that `claude agents` lists with no PID gets no row. A row shows the glyph of the level, the name, a summary of 1 line and the time at that level. The rows sort by level, then by the longest time at that level.

| Level | When |
|---|---|
| NEEDS YOU | The session waits for you: a question, a permission prompt or another dialog. |
| YOUR TURN | The session is idle, and its last turn ended after you last saw it. |
| STUCK | The session is busy, and its transcript ends with an API error or retry. Or the session is busy for 10 min with no transcript write. |
| WORKING | The session is busy. |
| IDLE | The session is idle for less than 24 h, and you saw its last turn. |
| STALE | The session is idle for 24 h or more, and you saw its last turn. This group starts closed. |

The limits of 10 min and 24 h are the defaults of 2 settings.

A press on a session row or a jump marks the session as seen. A session that you did not open or jump to yet counts as seen at the start of the pane. So when the pane starts, only a turn that ends after that start goes to YOUR TURN.

Rules write each summary, and no model writes it. A waiting session shows its question or its permission request. A busy session shows its activity or the API error at the end of its transcript. Else the summary is the first sentence of the last reply.

The detail of the selected session has 5 tabs: Now, History, Agents, Screen and Recap. It also names each overlap with another session:

- `SAME TREE`: the 2 sessions work in the same worktree on the same branch.
- `SAME FILES`: the 2 sessions wrote the same file in the last 2 h, in the part of each transcript that the mod read.
- `SAME REPO`: the 2 sessions work in the same repo, in different worktrees.

A board row shows `TREE` or `FILES` after the name. At 90 columns or more, the pane shows the board and the detail side by side. Below 90 columns, it shows the board alone, and Enter shows the detail in place of the board.

## Keys

Press `ctrl+x tab` to give the keys to the pane. The key row at the bottom of the pane shows the keys of the board. A key that cannot work now shows dim.

| Key | What it does |
|---|---|
| ↑ ↓ | Select a session. |
| Enter | Open the selected session and mark it as seen. On the `STALE` heading, open or close the group. |
| `b` | Go back to the board from the detail of a narrow pane. |
| `j` | Jump to the cmux tab of the selected session. |
| `n` | Select the next session that needs you. |
| `1` to `9` | Answer the open question, or the Bash permission prompt (`1: Yes`, `2: No`). |
| `r` | Write a prompt for the selected session. |
| `m` | Write a peer message to the selected session. |
| `t` | Show the next tab of the detail. |
| `s` | Turn all tones off, or on again. |
| `u` | Mute the selected session, or unmute it. |
| `f` | Switch between all sessions and the repos mode. |
| `g` | Group the rows by level or by repo. |
| `x` | Make a Recap. This key shows only on the Recap tab. |
| `w`, `z` | Show the lines above (`w`) or below (`z`) a cut text. |
| `y`, `c` | Send or cancel in the confirm bar. |

After `r` or `m`, type a line and press Enter. Each Enter adds the line to the draft. Press Enter on an empty line to open the confirm bar.

## Safety of the key path

WARNING: A key that goes to the wrong dialog can approve a tool call in another session. Read the confirm bar before you press `y`.

The pane types into another session only through cmux. Each answer and each prompt goes through these steps:

1. You press `y` in the confirm bar. The bar shows the session name and what goes to it. That is the option and its question, `Yes` or `No` and the whole tool input, or the whole text. A long text scrolls with `w` and `z`, so you can read all of it before `y`.
2. The pane reads the process of the session with `ps`. Then it reads the registry file and the transcript of the session again, and then the screen of its cmux tab.
3. The pane checks that the process still runs with the start time of the registry file, on the terminal of the cmux tab.
4. The pane checks that it read the screen 1 s ago or less, and the session facts 1 s or less before the screen.
5. The pane checks that the session still takes the key, and that the screen still shows the same dialog or prompt line.
6. The pane types the keys. An answer is the digit alone. A prompt is 1 `cmux send` for each line, with `shift+enter` between the lines and `enter` at the end.
7. The next refreshes check the result. The pane then shows `Delivered to <name>.` or `Not delivered. Check the Screen tab.`

The check of step 5 depends on what goes out:

- An answer needs a session that waits on the same question. The screen must show the same header, question and label at that digit.
- A Bash answer needs a session that waits on a permission prompt. The screen must show the same command and an option labeled exactly `Yes` or `No`.
- A prompt needs an idle session with no open question. The screen must show an empty prompt line and no dialog.

Before each next line of a prompt, the pane reads the registry file and the screen again. If the session or the screen changed, the pane stops, and no later line goes out.

If a read or a check of steps 2 to 5 fails, the pane sends nothing and shows the reason. When the pane has a fresh screen, it also opens the Screen tab with that screen.

The pane does not send these. Press `j` and do them in the tab of the session:

- An answer to a permission prompt of any tool but Bash. The screen check can tie only a shell command to its dialog.
- Any option of a Bash prompt but the 2 options labeled exactly `Yes` and `No`.
- An answer to a dialog with more than 1 question or more than 1 choice.
- A prompt whose first character after white space is `!` (a shell command) or `?` (the help).
- A prompt whose first line is `exit`, `quit`, `:q`, `:q!`, `:wq`, `:wq!`, `/exit` or `/quit`, in any case.
- A prompt with a control character, or with a character that does not show. Some emoji hold such a character.
- A prompt with a backslash before `n`, `r` or `t` in any case, or with a line that ends with a backslash.
- A prompt to a session that runs a background task or a subagent. Either can open a dialog while the keys go out.

A prompt that starts with `/` can go out after the same checks. Its confirm bar says that the session runs it as a command.

`m` sends a peer message through Claude Code, with no screen check. The session reads it as a message from a peer, not as your prompt. The confirm bar is the only guard of a peer message.

## What it reads

The levels, the summaries and the flags come from rules only. orangu god reads these sources:

- `claude agents --json`, every 15 s.
- The registry files `~/.claude/sessions/<pid>.json`, every 2 s. It reads only the files that changed.
- The end of each transcript under `~/.claude/projects/`, with `stat`, `tail` and `head`. The first read takes the last 512 KiB, and each later read takes only the new bytes. A file that gets smaller, or a new file at that path, gets a new first read.
- The subagent files of each session.
- `git rev-parse` in the folder of each new session, to find its repo.
- `cmux tree` and `ps`, every 15 s, to find the tab of each session.
- `cmux read-screen` of 1 tab, every 1 s, while the Screen tab shows it.

The mod runs no command but `claude`, `cmux`, `ps`, `git`, `stat`, `tail` and `head`, and each command stops after 5 s. It reads only the `HOME` and `ORANGU_GOD` variables. It writes no file. It keeps the mode, the repo set, the grouping, the seen times, the mutes and the sound setting in the plugin store of Claude Code.

Before the pane shows a transcript text, a session name, a cmux title or a screen, the mod removes the terminal control characters. Then it masks the secrets with the orangu redaction. The same cleaned text goes to the tools and to the Recap.

The mod gives the god Claude 2 tools: `mcp__orangu-god__board` (1 line for each session) and `mcp__orangu-god__session` (the detail of 1 session). The tools only read. They register when the pane opens for the first time.

## Recap

The Recap is the only model text of orangu god. It runs only when you press `x` on the Recap tab, and only 1 Recap runs at a time.

The Recap sends the facts of 1 session and its last 6 turns to a Haiku model, through Claude Code. The facts are the name, the title, the level, the wait reason, the open question and the last tool. The mod cleans each text first and cuts a longer text to 1,500 characters. The whole prompt holds 20,000 UTF-8 bytes or fewer. To stay under that limit, the mod leaves out the oldest turns first.

The Recap tab shows the reply under a `model text` label, with its token count.

## Alerts

- An alert starts when a session goes into NEEDS YOU or STUCK. It is 1 tone, 1 native notification and 1 ring on the cmux tab of the session.
- When a session goes into YOUR TURN, the pane plays a done tone. A done tone has no notification and no ring.
- A session gets at most 1 alert in 5 min. A done tone also waits 5 min after the last alert or done tone of that session.
- The first refresh after the start sends no alert. A refresh more than 5 min after the last one sends no alert either.
- Only the session that shows the pane plays tones. `s` turns the tones off, and the notifications and the rings stay.
- `u` mutes the selected session: it gets no alert and no tone.
- The mod makes its 3 tones from code. No audio file ships.

While the pane is not on the screen and 1 or more sessions need you, the status line shows their count, for example `god: 2 need you`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `stuckAfterMin` | `10` | A busy session with no transcript write for this many minutes shows as stuck. |
| `staleAfterH` | `24` | An idle session shows as stale after this many hours. |
| `motion` | `on` | Set it to `off` to stop each spinner, pulse and sparkline of the pane. |
