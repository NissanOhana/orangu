# Show-me slot rules

You write 3 values in `words.json`: `verdict`, `summary` and `improvementsTitle`. Orangu fills every other slot of the slide deck and the written report from `data.json`, and writes each value as text.

Write each value in STE, as plain text on one line. Use no Markdown and no HTML. Use no judgement word, no score and no number that `data.json` does not show.

## `verdict`

Say how the session ended and what it produced. Use `summary.ending` and `summary.outcomes`. In repo and global scope, name the main pattern: the first item of `findings`.

The deck shows the verdict on its own slide. The written report shows it above the numbers.

## `summary`

Give the outcome first, then the main finding, then the next step. The main finding is the first insight that `summary.topInsightIds` names. In repo and global scope, it is the first item of `findings`. The next step is the `improvement` of the main finding. If there is no finding, say that the rules found none.

Only the written report shows the summary.

## `improvementsTitle`

Write a heading that names the change that the improvements make. The deck shows it above the list of improvements, and only when the list has an item.
