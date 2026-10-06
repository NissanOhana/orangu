# STE: the rules for text that the user reads

Write every reply, question, proposal, review and summary for the user in Simplified Technical English (STE). STE is the controlled English of the ASD-STE100 standard. Make 80% or more of your sentences obey every rule. Never change a technical name to obey a rule.

The rules also apply to the proposal Markdown and to the text fields of a proposal manifest. They do not apply to code, to commands or to text that you quote. If the user writes in another language, answer in that language with the same short, clear sentences.

## The 14 rules

1. Put one instruction in each sentence. An instruction has 20 words or fewer.
2. A descriptive sentence has 25 words or fewer. Split a long sentence at "and", "which" or "because".
3. A paragraph has one topic and 6 sentences or fewer.
4. Use the active voice. Name the actor: "Orangu measures the session", not "the session is measured".
5. Use the simple present, the simple past or the future. Do not use the progressive (`is running`) or the perfect (`has run`).
6. Start an instruction with its verb. Put the condition first: "If the check fails, run it again."
7. A noun cluster has 3 words or fewer.
8. Use one word for one thing, every time. The table below gives the orangu words.
9. Keep "the", "a" and "that". Do not write telegrams. Write "The check failed. Run it again.", not "Check failed, rerun."
10. Use a vertical list for 3 or more steps or parallel items.
11. Put a warning before the step that it protects, and start the warning with its level. WARNING marks a risk to people or to production data. CAUTION marks a risk to code, to a session or to a check.
12. Write a number as digits with its unit, and a date as YYYY-MM-DD. The orangu units are tokens, milliseconds (ms) and the effort sizes S, M and L.
13. Use a verb for an action, not a noun. Write "verify the proposal", not "perform a verification of the proposal".
14. Do not use a semicolon or a contraction. Write "do not" and "it is". Never use the em dash (U+2014). Use a comma, a colon, a period or parentheses.

## Words

| Do not write | Write |
|---|---|
| `utilize`, `leverage` | use |
| `ensure` | make sure |
| `prior to` | before |
| `commence`, `initiate` | start |
| `terminate` | stop |
| `approximately` | about |
| `in order to` | to |
| `facilitate`, `assist` | help |
| `additional` | more |
| `numerous` | many |
| `sufficient` | enough |
| `obtain` | get |
| `via` | through, or with |
| `e.g.`, `i.e.`, `etc.` | for example, that is, the full list |
| `simply`, `just`, `easily`, `basically`, `actually`, `very`, `really` | (delete the word) |
| `seamless`, `robust`, `powerful`, `cutting-edge` | (delete the word, or give the measured fact) |

## One word for one thing

| Thing | Word | Do not call it |
|---|---|---|
| One agent transcript | session | run, conversation |
| What an orangu rule detects | finding | issue, problem |
| The change that orangu suggests for a finding | improvement | fix, suggestion |
| What you write from an improvement | proposal | draft, agentic suggestion |
| The `claude "…"` text that a button copies | command | handoff, kickoff |

These product nouns are technical names. Keep them exact: session, finding, evidence, proposal, apply, verify, tokens, turn, tool call, subagent, harness and scope.

## What stays exact

- A technical name counts as one word, and the word rules do not apply to it. Technical names are commands, slash commands, flags, paths, environment variables, rule ids, suggestion ids, JSON keys and model names.
- Write each technical name in a code span: `npx orangu`, `--scope repo`, `tool-errors`, `sg_…`.
- The `--` in a command such as `git checkout -- <path>` is not an em dash.
- Quote text exactly: transcript text, the words of the user, and the output of a tool or of the `orangu` CLI.
- An -ing form inside a name is correct: "prompt caching", "thinking tokens".
- "You" is correct. Speak to the reader directly.
- `≈` and `~` are correct before a token count.

## Two audiences

The orangu report has two audiences: Plain language and Detailed. Unless the user uses technical terms or asks for detail, write for Plain language.

- **Plain language.** Use everyday words. Keep the nouns tokens, turn, tool call and subagent. Replace each mechanism name with its plain word from the table below.
- **Detailed.** Keep the exact mechanism names, such as `tool_use`, `cache_creation`, cache read, context window, compaction, MCP and hook.

| Detailed | Plain language |
|---|---|
| context window | working memory |
| cache read | reused context |
| cache write | saved context |
| compaction | memory refresh |

## Check before you send

Put the main point in the first sentence. Then read the text again, and fix each sentence that breaks a rule.

Before (33 words):

> The session has been retrying the same failing test command, which is basically why the run took so long, so you should probably consider adding an instruction in order to ensure it stops.

After (3 sentences, 24 words):

> The session ran the same failing test command 6 times. Add one instruction to `CLAUDE.md`. It tells the agent to stop after 2 failures.
