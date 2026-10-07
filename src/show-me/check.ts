/**
 * The self-check of one filled file against its template, before anything is written. The fill writes only
 * escaped text, checked attributes and finite numbers, so each check below holds by construction. The check is
 * the second line: a fill bug that lets a value become markup stops here, and the render writes nothing.
 *
 * 1. `<html>` matches one exact pattern: `lang="en"` and the 4 root attributes, each a fixed word, in order.
 *    The fill rewrites that tag, so it cannot be compared byte for byte.
 * 2. The bytes before `<html`, the bytes between the tag and `<head>`, and `<head>` up to and including the
 *    `/>` of the CSP meta equal the template byte for byte.
 * 3. The whole head equals the template head, with the text of the one `<title>` slot left out.
 * 4. There is exactly one `<script`, and the sha256 of its raw body is the build hash (SCRIPT_HASH). The `<style`
 *    count is the template's: Chromium reads a `<style>` inside `<svg>` as markup, and the checks 5 to 7 skip styles.
 * 5. In the tags, exactly one `http-equiv`, and it is the CSP. A refresh navigates, and the CSP cannot stop it.
 * 6. The `href` values of the tags equal those of the template (the one sibling link), and the `<meta` count is
 *    the template's.
 * 7. Every tag name and every attribute name is one that the template has, so no `<set>`, `<base>` or `on...`.
 * The checks 5 to 7 read tags only, outside the style and the script: escaped text holds no `<`, so a text that
 * says "http-equiv" or "href=" is text, and it does not stop the render.
 */
import { createHash } from 'node:crypto'
import { SCRIPT_HASH } from './generated/templates.js'

/** A filled file that differs from its template where the fill may not change it. */
export class SelfCheckError extends Error {
  override readonly name = 'SelfCheckError'
}

const HTML_TAG = /^<html lang="en" data-scope="(?:session|repo|global)" data-live="(?:true|false)" data-caution="(?:true|false)" data-redacted="(?:true|false)">$/
const CSP = '<meta http-equiv="Content-Security-Policy" content="'
const SCRIPT = /<script>([\s\S]*?)<\/script>/

interface Head {
  prefix: string
  tag: string
  between: string
  /** `<head>` up to and including the `/>` of the CSP meta */
  toCsp: string
  /** the whole `<head>…</head>`, the title text left out */
  masked: string
}

function head(html: string, what: string): Head {
  const open = html.indexOf('<html')
  const tagEnd = html.indexOf('>', open) + 1
  const start = html.indexOf('<head>', tagEnd)
  const csp = html.indexOf(CSP, start)
  const cspEnd = csp < 0 ? -1 : html.indexOf('/>', csp)
  const end = html.indexOf('</head>', start)
  if (open < 0 || tagEnd <= 0 || start < 0 || csp < 0 || cspEnd < 0 || end < 0) throw new SelfCheckError(`${what} has no <html>, <head> or CSP meta in place`)
  const whole = html.slice(start, end + '</head>'.length)
  return {
    prefix: html.slice(0, open),
    tag: html.slice(open, tagEnd),
    between: html.slice(tagEnd, start),
    toCsp: html.slice(start, cspEnd + 2),
    masked: whole.replace(/(<title data-slot="title">)[^<]*(<\/title>)/, (_match, before: string, after: string) => before + after),
  }
}

/** The markup outside the style and the script: the one place where a tag can stand. */
function tags(html: string): string[] {
  return html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '').match(/<[a-zA-Z][^>]*>/g) ?? []
}
const tagName = (tag: string): string => /^<([a-zA-Z][\w-]*)/.exec(tag)![1]!.toLowerCase()
/** attribute names: quoted values are blanked first, so a word inside a value is never read as a name */
const attributeNames = (tag: string): string[] =>
  [...tag.replace(/"[^"]*"|'[^']*'/g, '""').slice(1 + tagName(tag).length).matchAll(/([^\s=/>"']+)/g)].map((m) => m[1]!.toLowerCase())
const hrefs = (all: readonly string[]): string[] => all.flatMap((tag) => [...tag.matchAll(/\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => m[1]!)).sort()
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

/** Throw a SelfCheckError when `out` differs from `template` in a place the fill may not change. */
export function selfCheck(out: string, template: string, what = 'the file'): void {
  const fail = (rule: string): never => {
    throw new SelfCheckError(`${what} failed the self-check: ${rule}`)
  }
  const mine = head(out, what)
  const theirs = head(template, 'the template')
  if (!HTML_TAG.test(mine.tag)) fail('the <html> tag is not the fixed tag with its 4 enum attributes')
  if (mine.prefix !== theirs.prefix || mine.between !== theirs.between) fail('the bytes around the <html> tag differ from the template')
  if (mine.toCsp !== theirs.toCsp) fail('the head up to the CSP meta differs from the template')
  if (mine.masked !== theirs.masked) fail('the head differs from the template')

  if (count(out, /<script\b/gi) !== 1 || count(out, /<\/script/gi) !== 1) fail('it must hold exactly one script')
  // the tag checks below skip style blocks, and Chromium reads a <style> in an <svg> as markup: only the head style
  // of the template may stand in the file
  if (count(out, /<style\b/gi) !== count(template, /<style\b/gi) || count(out, /<\/style/gi) !== count(template, /<\/style/gi)) fail('it must hold only the style of the template')
  const body = SCRIPT.exec(out)?.[1]
  if (body === undefined || createHash('sha256').update(body, 'utf8').digest('base64') !== SCRIPT_HASH) fail('the script is not the pinned runtime')

  const own = tags(out)
  const model = tags(template)
  const equivs = own.flatMap((tag) => tag.match(/\bhttp-equiv\s*=\s*["']?[^"'\s>]*/gi) ?? [])
  if (equivs.length !== 1 || equivs[0] !== 'http-equiv="Content-Security-Policy') fail('the CSP must be the one http-equiv')
  if (hrefs(own).join('\n') !== hrefs(model).join('\n')) fail('the links differ from the template')
  if (count(out, /<meta\b/gi) !== count(template, /<meta\b/gi)) fail('the meta tags differ from the template')
  const names = new Set(model.map(tagName))
  if (own.some((tag) => !names.has(tagName(tag)))) fail('it holds a tag that the template does not have')
  const attributes = new Set(model.flatMap(attributeNames))
  if (own.some((tag) => attributeNames(tag).some((name) => !attributes.has(name)))) fail('it holds an attribute that the template does not have')
}
