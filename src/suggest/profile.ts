/**
 * The profile of the interview: `<orangu home>/profile.json`, profile v1 (docs/DATA-CONTRACTS.md, "Profile v1").
 * The interview skill writes the file. orangu only reads it, and treats it as untrusted: the read stops at a symlink,
 * a file that is not regular and a file over 16,384 B (src/util/stable-file.ts), and the shape check refuses an
 * unknown key, a wrong type and a value over its limit.
 *
 * `profileStatus` says where the file is and whether it reads as profile v1. It holds no profile value, so the CLI
 * and the app can print it. `loadProfile` is the only function that gives the values.
 */
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { oranguHome } from '../util/home.js'
import { readStableTextFile } from '../util/stable-file.js'

type Env = Record<string, string | undefined>

/** The largest profile file that orangu reads. */
export const PROFILE_MAX_BYTES = 16_384
/** The mode of an orangu home that orangu makes, as the store makes its folders (src/suggest/store.ts:61). */
const PRIVATE_DIRECTORY_MODE = 0o700

export type ProfileHow = 'option' | 'own' | 'skipped'

/** 1 question of the interview and its answer. `how` says if the answer is an option, own words or a skip. */
export interface ProfileAnswer {
  q: string
  a: string
  how: ProfileHow
}

/** Profile v1. A skipped question leaves its key out, so only `v` and `updatedAt` are always present. */
export interface ProfileV1 {
  v: 1
  updatedAt: string
  role?: string
  work?: string[]
  process?: string
  priority?: 'quality' | 'time' | 'tokens'
  models?: 'yes' | 'ask' | 'no'
  audience?: 'local' | 'shared'
  repeats?: string
  never?: string
  answers?: ProfileAnswer[]
}

/** Where the profile is, and whether it reads as profile v1. It holds no profile value. */
export interface ProfileStatus {
  path: string
  /** false only when no entry is at the path */
  exists: boolean
  valid: boolean
  /** the `updatedAt` of a valid profile, else null */
  updatedAt: string | null
}

type OptionalKey = Exclude<keyof ProfileV1, 'v' | 'updatedAt'>

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HOWS: readonly string[] = ['option', 'own', 'skipped']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A string of `max` characters at most. A character is 1 Unicode code point, so an emoji counts as 1. */
const isText = (value: unknown, max: number): boolean => typeof value === 'string' && Array.from(value).length <= max

const isOneOf = (value: unknown, values: readonly string[]): boolean => typeof value === 'string' && values.includes(value)

const isAnswer = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).length === 3 &&
  typeof value['q'] === 'string' &&
  typeof value['a'] === 'string' &&
  isOneOf(value['how'], HOWS)

/** The type and the limit of each key that a skipped question leaves out, in the order of profile v1. */
const CHECKS: Readonly<Record<OptionalKey, (value: unknown) => boolean>> = {
  role: (value) => isText(value, 200),
  work: (value) => Array.isArray(value) && value.length <= 6 && value.every((item) => isText(item, 120)),
  process: (value) => isText(value, 200),
  priority: (value) => isOneOf(value, ['quality', 'time', 'tokens']),
  models: (value) => isOneOf(value, ['yes', 'ask', 'no']),
  audience: (value) => isOneOf(value, ['local', 'shared']),
  repeats: (value) => isText(value, 500),
  never: (value) => isText(value, 500),
  answers: (value) => Array.isArray(value) && value.length <= 12 && value.every(isAnswer),
}
const OPTIONAL_KEYS = Object.keys(CHECKS) as OptionalKey[]
const PROFILE_KEYS: readonly string[] = ['v', 'updatedAt', ...OPTIONAL_KEYS]

/** The profile v1 in a parsed file, as a new object in the key order of v1. Null when 1 key fails its check. */
function profileOf(value: unknown): ProfileV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !PROFILE_KEYS.includes(key))) return null
  const { v, updatedAt } = value
  if (v !== 1 || typeof updatedAt !== 'string' || !DATE_RE.test(updatedAt)) return null
  if (!OPTIONAL_KEYS.every((key) => !Object.hasOwn(value, key) || CHECKS[key](value[key]))) return null
  const profile: ProfileV1 = { v: 1, updatedAt }
  for (const key of OPTIONAL_KEYS) if (Object.hasOwn(value, key)) Object.assign(profile, { [key]: structuredClone(value[key]) })
  return profile
}

interface ProfileRead {
  path: string
  exists: boolean
  profile: ProfileV1 | null
}

async function readProfile(env: Env): Promise<ProfileRead> {
  const path = join(oranguHome(env), 'profile.json')
  try {
    await lstat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // No entry at the path, or a part of the path that is a file: no profile exists.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path, exists: false, profile: null }
    // An entry that orangu cannot look at exists, and it does not read.
    return { path, exists: true, profile: null }
  }
  try {
    return { path, exists: true, profile: profileOf(JSON.parse(await readStableTextFile(path, PROFILE_MAX_BYTES, 'profile'))) }
  } catch {
    // A symlink, a file that is not regular, a file over the cap, a file that changed during the read, or bad JSON.
    return { path, exists: true, profile: null }
  }
}

/**
 * Make the orangu home with mode 0700 when it is missing, so the profile write lands in a private folder. A folder
 * that exists keeps its mode. It throws the error of `mkdir`, such as EEXIST when the home path is a file.
 */
export async function prepareProfileHome(env: Env = process.env): Promise<void> {
  await mkdir(oranguHome(env), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
}

/** Where the profile is and whether it reads as profile v1, with no profile value. */
export async function profileStatus(env: Env = process.env): Promise<ProfileStatus> {
  const { path, exists, profile } = await readProfile(env)
  return { path, exists, valid: profile !== null, updatedAt: profile?.updatedAt ?? null }
}

/** The validated profile v1, or null when no file reads as profile v1. The values are the words of the user. */
export async function loadProfile(env: Env = process.env): Promise<ProfileV1 | null> {
  return (await readProfile(env)).profile
}
