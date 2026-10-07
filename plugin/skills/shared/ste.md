# STE: the rules for text that the user reads

Write every reply, question, proposal, review and summary for the user in Simplified Technical English (STE). STE is the controlled English of the ASD-STE100 standard. Make 80% or more of your sentences obey every rule. Never change a technical name to obey a rule.

The rules also apply to the prose of the proposal Markdown. In a proposal manifest, they apply only to the prose fields: `title`, `change`, `evidence`, `expectedEffect`, `risk` and `verification`. Every other manifest value stays exactly as the artifact contract says: ids, enum values, `sources` labels, URLs, dates and paths. Do not put code spans inside JSON values. Text that a proposal puts into a repository file, such as `CLAUDE.md`, keeps the exact mechanism names and the conventions of that repository.

The rules do not apply to code, to commands or to quoted text. If the user writes in another language, answer in that language with the same short, clear sentences.

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
12. Write a number as digits with its unit, and a date as YYYY-MM-DD. Usage is in tokens. A read size is in bytes. Time is in milliseconds (ms). Effort is S, M or L. Orangu has no other unit for usage.
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

Each row names one thing. One run of a skill is not a session, so do not rename it. These product nouns are technical names. Keep them exact: session, finding, evidence, proposal, apply, verify, tokens, turn, tool call, subagent, harness and scope.

## What stays exact

- A technical name counts as one word, and the word rules do not apply to it. Technical names are commands, slash commands, flags, paths, environment variables, rule ids, suggestion ids, JSON keys and model names.
- In chat and in Markdown, write each technical name in a code span: `npx orangu`, `--scope repo`, `tool-errors`, `sg_…`.
- The `--` in a command such as `git checkout -- <path>` is not an em dash.
- When you quote text, keep its exact words. Quote only what the skill allows.
- A sentence that a skill tells you to say stays word for word.
- An -ing form inside a name is correct: "prompt caching", "thinking tokens".
- "You" is correct. Speak to the reader directly.
- `≈` and `~` are correct before a token count.

## Two audiences

The orangu report has two audiences: Plain language and Detailed. Use the audience that the user asks for. If the skill that sent you here names a default audience, use it. If not, match the words that the user uses.

- **Plain language.** Use everyday words. Keep the nouns tokens, turn, tool call and subagent. Replace each mechanism name with its plain word from the table below, but never in text for a repository file.
- **Detailed.** Keep the exact mechanism names, such as `tool_use`, `cache_creation`, cache read, context window, compaction, MCP and hook.

| Detailed | Plain language |
|---|---|
| context window | working memory |
| cache read | reused context |
| cache write | saved context |
| compaction | memory refresh |

## Lead with the point

1. Put the answer, or the change to make, in the first sentence.
2. Then give the reason.
3. Put the method, the evidence and the limits last, under their own heading. If the user did not ask for them and the answer does not depend on them, leave them out.
4. Say each point once. Do not end with a summary of what you said.

## Check before you send

Read the text again. Fix each sentence that breaks a rule. Then check the text with `orangu ste`:

1. If you wrote the text to a file, run `orangu ste '<path>'`.
2. If the text goes to chat, pass the draft on stdin, as the quoted here-document in [the untrusted-input rules](untrusted-input.md). Never put a draft in an argument.
3. Fix each finding that is real. Do not rewrite a correct sentence to clear a finding. Do not chase a score.

`orangu ste` has no pass mark. It cannot see the passive voice or a long noun cluster, so a clean result does not prove that the text obeys every rule.

Before (33 words):

> The session has been retrying the same failing test command, which is basically why the run took so long, so you should probably consider adding an instruction in order to ensure it stops.

After (3 sentences, 24 words):

> The session ran the same failing test command 6 times. Add one instruction to `CLAUDE.md`. It tells the agent to stop after 2 failures.
