/**
 * Plain text that a session holds and that holds no secret: ids, hashes, paths, model ids, code, and words of real
 * transcripts that end with a key prefix (helpdesk-, risk-, task-, network_test_, weighs_, pnpm_, MSG., surveyJs).
 * The redaction keeps each line as it is. Seeded generators make the ids, so each run reads the same lines.
 */
let seed = 20_261_101
const next = (n: number): number => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
  return (seed >>> 8) % n
}
const pick = (length: number, alphabet: string): string => Array.from({ length }, () => alphabet[next(alphabet.length)]).join('')
const HEX = '0123456789abcdef'
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const NANOID = `${BASE62}_-`
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const uuid = (): string => [8, 4, 4, 4, 12].map((n) => pick(n, HEX)).join('-')

/** Words before a key prefix, in the shapes that real transcripts hold them. */
const NEAR_MISSES = [
  'helpdesk-internationalsupport',
  'helpdesk-supportteamnotifications',
  'mail helpdesk-internationalsupport today',
  'risk-managementdepartment',
  'risk-assessmentframeworkreview2026',
  'task-0123456789abcdefghijkl',
  'Task-1A2B3C4D5E6F7A8B9C0D1E2F',
  'disk-ABCDEFGHIJKLMNOPQRSTUV',
  'desk-AAAAAAAAAAAAAAAAAAAAAAAA',
  'flask-ant-design-admin-template',
  'kiosk-ant-design-system-v2-starter',
  'task-proj-2024-q4-planning-board',
  'network_test_ConnectionRefused1',
  'def test_network_test_ConnectionRefused1(self):',
  'framework_test_HandlesLargeInputFiles',
  'benchmark_live_StreamingThroughput',
  'daily_highs_and_lows_by_symbol_and_date',
  'weighs_and_measures_conversion_table',
  'pnpm_abcdefghijklmnopqrstuvwxyz01234',
  'MSG.abcdefghijklmnopqrstuvw.abcdefghijklmnopqrstuv',
  'ERROR_MSG.someVeryLongFieldName.anotherVeryLongField',
  'this.surveyJsConfiguration.questionsAndAnswers.items',
  'monkeyJumpingOverTheFence.somethingElseLong.value',
  'const keyJsonPathResolver = config.apiKeyJsonFilePath.trim()',
  'task-admin-dashboard-settings-page',
  'use_hf_tokenizer_for_pretrained_models',
  'useBearer authenticationheader',
  'installation_authorization = await client.check',
]

const MODEL_IDS = [
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-opus-5[1m]',
  'claude-fable-5-1',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-latest',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic/claude-3.5-sonnet',
  'gpt-4o-mini-2024-07-18',
  'gpt-5-codex',
  'o3-mini',
  'gemini-2.5-pro-preview-05-06',
  '<synthetic>',
]

const PATHS = [
  '/Users/test/Code/orangu/src/redact/rules.ts:19:3',
  '~/.claude/projects/-Users-test-Code-orangu/1f31fc6e-0b7a-4c2e-9d3f-8a5b6c7d8e9f.jsonl',
  'node_modules/.pnpm/vitest@4.1.12/node_modules/vitest/dist/index.js',
  'C:\\Users\\test\\AppData\\Local\\Temp\\orangu-AbC123',
  '/var/folders/ab/cd12ef34gh56ij78kl90mn12op34qr/T/vitest-3f2a9c',
  'src/report/client/agg-entry.ts',
  '.github/workflows/release.yml',
  '/opt/homebrew/Cellar/node/24.1.0/bin/node',
  'test/fixtures/key-prefix-shapes.ts',
  '/tmp/task-runner/desk-booking/disk-usage.log',
  'src/tasks/risk-scoring/flask-app/__init__.py',
  'apps/helpdesk-portal/src/components/TaskList.tsx',
  'packages/ask-sdk-core/lib/index.js',
  '/home/test/.cache/pnpm/store/v3/files/3f/2a9c1b7e4d8f0a6b5c',
  'docs/USAGE.md',
  '/Users/test/Library/Application Support/Code/User/settings.json',
  'src/god/generated/tokens.ts',
  'plugin/skills/shared/untrusted-input.md',
]

const CODE = [
  'export ANTHROPIC_MODEL=claude-opus-5',
  'git checkout -b fix/risk-scoring-edge-case',
  'npm install @anthropic-ai/claude-agent-sdk@0.1.0',
  'docker run ghcr.io/owner/flask-ant-design:sha-3f2a9c1',
  'kubectl logs celery-task-5f7b8c9d4e-abcde',
  'kubectl get pod flask-app-7d4b9c8f6-x2k4p -o yaml',
  'arn:aws:iam::123456789012:role/task-runner',
  'arn:aws:s3:::my-bucket/risk-reports/2026/11/01/report.csv',
  'https://code.claude.com/docs/en/prompt-caching.md',
  'http://127.0.0.1:4173/_orangu/0123abcd/#start',
  'see http://localhost:3000/api and ws://127.0.0.1:9229/abc',
  '2026-11-01T12:34:56.789Z',
  'orangu@0.13.0 v0.13.0 2.1.316',
  'const total = usage.input_tokens + usage.cache_read_input_tokens',
  'if (risk_score > threshold) flag_task(task_id)',
  'SELECT task_id, risk_level FROM desk_bookings WHERE disk_quota > 0',
  'Fix the flaky test in src/cli/e2e.test.ts:702',
  'The agent read 12 files and ran 4 commands.',
  'token_count: 1234 total tokens: 5678',
  'Authorization header is missing',
  'curl -s https://api.example.com/v1/tasks?page=2&per_page=50',
  'python -m pytest tests/test_network.py -k ConnectionRefused -q',
  'cargo build --release --target aarch64-apple-darwin',
  'brew install ripgrep fd jq',
]

/** Lines that the redaction keeps as they are. */
export const PLAIN_TEXT_LINES: readonly string[] = [
  ...NEAR_MISSES,
  ...MODEL_IDS,
  ...PATHS,
  ...CODE,
  ...Array.from({ length: 40 }, () => uuid()),
  ...Array.from({ length: 10 }, () => `agent-a${pick(16, HEX)}`),
  ...Array.from({ length: 10 }, () => `toolu_01${pick(22, BASE62)}`),
  ...Array.from({ length: 10 }, () => `msg_01${pick(22, BASE62)}`),
  ...Array.from({ length: 10 }, () => `req_011C${pick(20, BASE62)}`),
  ...Array.from({ length: 20 }, (_, i) => `commit ${pick(7 + (i % 6), HEX)}`),
  ...Array.from({ length: 20 }, () => `md5 ${pick(32, HEX)}`),
  ...Array.from({ length: 20 }, () => `id ${pick(11 + next(30), BASE62)}`),
  ...Array.from({ length: 20 }, () => `nanoid ${pick(21, NANOID)}`),
  ...Array.from({ length: 20 }, () => `ulid ${pick(26, CROCKFORD)}`),
  ...Array.from({ length: 10 }, () => `sg_${pick(16, HEX)}`),
]

/** Lines that hold a hash, each with the marker that the redaction gives it before and after the glued rules. */
export const HASH_LINES: ReadonlyArray<readonly [text: string, redacted: string]> = [
  ...Array.from({ length: 6 }, () => {
    const sha = pick(40, HEX)
    return [`commit ${sha} (HEAD -> main)`, 'commit ‹hash40› (HEAD -> main)'] as const
  }),
  ...Array.from({ length: 6 }, () => [`sha256:${pick(64, HEX)}`, 'sha256:‹blob›'] as const),
]
