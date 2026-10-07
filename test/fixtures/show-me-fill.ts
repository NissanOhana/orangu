/**
 * The show-me fill for tests. The fill itself lives in src/show-me (the code behind `orangu show-me --render`), and
 * this module re-exports it, so a test fills the templates through the same code as the CLI.
 */
export { FORMATS, escapeHtml, fillTemplate, type Chart, type Item, type Page, type Scope, type SlotValue } from '../../src/show-me/fill.js'
export { aggregatePage, sessionPage } from '../../src/show-me/pages.js'
export type { Words } from '../../src/show-me/words.js'
