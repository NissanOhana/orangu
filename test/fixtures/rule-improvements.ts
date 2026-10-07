/**
 * Every `improvement` text that a rule site of src/analyze/insights.ts can emit, read from the TypeScript AST of
 * the source, as src/analyze/rule-copy.test.ts reads it: the argument of each mk(...) call, and its improvement
 * as a string literal, a conditional of literals, or a local constant of those. A rule that never fires on a
 * fixture still has its text here, so a test that renders the longest texts follows each rule rewrite.
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The initializer of the constant `name`, declared in a function that encloses `from`. */
function localConst(from: ts.Node, name: string): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) continue
    let found: ts.Expression | undefined
    const look = (node: ts.Node): void => {
      if (found) return
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
        const list = node.parent
        if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) found = node.initializer
      } else if (!ts.isFunctionLike(node)) ts.forEachChild(node, look)
    }
    ts.forEachChild(scope, look)
    if (found) return found
  }
  return undefined
}

/** Every text the expression can produce. A branch that is not fixed text is an error: rule text is fixed. */
function fixedTexts(node: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(node)) return fixedTexts(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isConditionalExpression(node)) return [...fixedTexts(node.whenTrue), ...fixedTexts(node.whenFalse)]
  if (ts.isIdentifier(node)) {
    const init = localConst(node, node.text)
    if (init) return fixedTexts(init)
  }
  throw new Error(`an improvement that is not fixed text at ${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
}

/** Each distinct improvement text of the rule sites, in source order. */
export function ruleImprovements(root = process.cwd()): string[] {
  const path = join(root, 'src', 'analyze', 'insights.ts')
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const texts: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'mk') {
      const arg = node.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'improvement') texts.push(...fixedTexts(p.initializer))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...new Set(texts)]
}

/** The `count` longest improvement texts, longest first. */
export const longestImprovements = (count: number, root?: string): string[] =>
  [...ruleImprovements(root)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, count)
