/**
 * The word tables of the STE checker (src/ste/index.ts). They are data, not copy: they hold the words that
 * the checker flags (e.g., etc., "utilize") and the word lists that it reads (the imperatives, the -ing
 * nouns, the command verbs). scripts/ste-surfaces.ts names this one file in SRC_EXEMPT for that reason.
 */

/** ASD-STE100 dictionary words: the word to avoid, then the word to write */
export const STE_WORDS: Readonly<Record<string, string>> = {
  commence: 'start',
  commencing: 'starting',
  ensure: 'make sure',
  ensures: 'makes sure',
  'prior to': 'before',
  replenish: 'fill',
  utilize: 'use',
  utilizes: 'uses',
  utilise: 'use',
  utilized: 'used',
  utilizing: 'using',
  ensured: 'made sure',
  ensuring: 'making sure',
  approximately: 'about',
  'in order to': 'to',
}

/** The house plain-word table: the word to avoid, then what to write */
export const PLAIN_WORDS: Readonly<Record<string, string>> = {
  leverage: 'use',
  leverages: 'uses',
  leveraging: 'using',
  leveraged: 'used',
  facilitate: 'help',
  facilitates: 'helps',
  additional: 'more',
  numerous: 'many',
  sufficient: 'enough',
  assist: 'help',
  obtain: 'get',
  terminate: 'stop',
  initiate: 'start',
  initiated: 'started',
  subsequently: 'then',
  'in the event that': 'if',
  'due to the fact that': 'because',
  'is able to': 'can',
  'are able to': 'can',
  'a number of': 'some, or the count',
  'at this point in time': 'now',
  'e.g.': 'for example',
  'i.e.': 'that is',
  'etc.': 'the full list',
  'incl.': 'including',
  via: 'through, or with',
  whilst: 'while',
  seamless: 'nothing, or the measured fact',
  seamlessly: 'nothing',
  robust: 'the measured fact',
  powerful: 'the measured fact',
  'cutting-edge': 'nothing',
  simply: 'nothing',
  just: 'nothing',
  easily: 'nothing',
  basically: 'nothing',
  essentially: 'nothing',
  actually: 'nothing',
  very: 'nothing, or a number',
  really: 'nothing',
}

/** The plain words that are also banned tokens: each surface carries a ceiling of 0 for each */
export const BANNED_WORDS: ReadonlySet<string> = new Set(['e.g.', 'i.e.', 'etc.'])

/** The first words that make a sentence an instruction (20 words), not a description (25 words). */
export const IMPERATIVES: ReadonlySet<string> = new Set(
  "add ask call check click copy create delete do don't draw enter find fix give keep list load make mark merge move name never open pick publish push put read record remove render run save select send set show start stop test type update use wait write".split(' '),
)

// Extend only for a measured false positive, and name the case in a comment.
export const ING_NOUNS: ReadonlySet<string> = new Set(['thing', 'nothing', 'something', 'anything', 'everything', 'during', 'morning', 'evening', 'string', 'ring', 'king', 'bring', 'spring', 'wing', 'ceiling', 'building', 'meaning', 'setting', 'warning', 'booking', 'pending', 'missing', 'funding', 'onboarding', 'bookkeeping', 'billing', 'pricing', 'routing', 'logging', 'testing', 'scheduling', 'matching'])

/** The verbs that make `orangu <verb>` a command. "orangu reads the file" is the product noun, not a command. */
export const ORANGU_VERBS: ReadonlySet<string> = new Set('report analyze list pick repo global watch serve feedback evidence estimate harness suggest ste show-me help'.split(' '))

export const GIT_VERBS: ReadonlySet<string> = new Set('add apply blame branch checkout cherry-pick clone commit config diff fetch grep init log merge mv pull push rebase reset restore revert rm show stash status switch tag worktree'.split(' '))
