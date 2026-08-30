# Design system

Orangu uses one visual language across the self-contained report, localhost app, sample, and landing page. The canonical implementation lives in `src/report/client/tokens.css`, `src/report/client/styles.css`, and `site/index.src.html`.

## Principles

1. Evidence stays inspectable. Metrics and findings link back to the turns and calls that produced them.
2. Quality is shown through named signals, never a composite score.
3. Detailed and plain-language views present the same evidence with different vocabulary and density.
4. Empty and unknown states are explicit. A missing signal is not rendered as zero.
5. Report and app assets are local and self-contained.

## Visual tokens

- `tokens.css` is the canonical palette and type-token source for the report and app.
- Terracotta is decorative on light backgrounds; `--accent-ink` owns links, focus rings, labels, and small marks.
- Category colors must remain distinguishable in both themes and must not carry meaning without a text label.
- System font stacks keep generated reports self-contained.
- Numeric columns use tabular figures and machine identifiers use the monospace stack.

Do not duplicate token values in feature CSS. The landing build imports the shared token block.

## Information architecture

The session experience is organized around:

```text
Overview -> Timeline -> Tools -> Agents -> Context and tokens -> Coverage -> Suggestions
```

Repo and Global add recurring-pattern views. Every screen should preserve the path from summary to evidence. Timeline filters and URL state make a selected view reproducible.

## Interaction

- Use native controls and visible `:focus-visible` states.
- Keep browser suggestion actions copy-only.
- Respect `prefers-reduced-motion`; every animated surface needs a stable static state.
- Preserve keyboard access for navigation, tabs, filters, details, and copy actions.
- Keep the report usable from `file://` without remote assets or storage APIs.
- Render narrow layouts without horizontal page overflow; dense tables may scroll inside their own container.

## Brand assets

The current raster mascot and favicon set live in [`design/brand/`](../design/brand/). Reports and the localhost app use the same `mascot-96.png` mark as the landing header. The mascot artwork is CC0.

## Verification

Visual changes should run:

```bash
npm run verify:generated
npm run test:browser
node scripts/assert-offline.mjs --file site/sample.html
node scripts/assert-offline.mjs --file site/sample-repo.html
node scripts/assert-offline.mjs --site
```

Check desktop and mobile layouts, both themes, keyboard navigation, reduced motion, and exported file mode.
