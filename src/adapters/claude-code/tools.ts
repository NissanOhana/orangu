import type { ToolCategory } from '../../model/session.js'

/** Map a Claude Code tool name to a coarse category used by the report. */
export function categorizeTool(name: string): ToolCategory {
  const n = name
  if (n === 'Read' || n === 'NotebookRead') return 'read'
  if (n === 'Grep' || n === 'Glob' || n === 'LS' || n === 'ToolSearch') return 'search'
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return 'edit'
  if (n === 'Write') return 'write'
  if (n === 'Bash' || n === 'BashOutput' || n === 'KillShell' || n === 'KillBash' || n === 'Monitor') return 'exec'
  if (n === 'Agent' || n === 'Task' || n === 'SendMessage' || n === 'ListAgents' || n === 'TaskOutput' || n === 'TaskStop' || n === 'Workflow') return 'agent'
  if (n === 'Skill') return 'skill'
  if (n === 'WebFetch' || n === 'WebSearch') return 'web'
  if (n === 'EnterPlanMode' || n === 'ExitPlanMode' || n === 'EnterWorktree' || n === 'ExitWorktree') return 'plan'
  if (n === 'AskUserQuestion') return 'ask'
  if (n === 'TaskCreate' || n === 'TaskUpdate' || n === 'TaskList' || n === 'TaskGet' || n === 'TodoWrite' || n === 'TodoRead') return 'task'
  if (n.startsWith('mcp__')) return 'mcp'
  return 'other'
}

function short(s: unknown, max = 80): string {
  if (typeof s !== 'string') return ''
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function baseName(p: unknown): string {
  if (typeof p !== 'string') return ''
  const parts = p.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? p
  const prev = parts.length > 1 ? parts[parts.length - 2] : ''
  return prev ? `${prev}/${last}` : last
}

/** One-line human summary of a tool call's input, e.g. "Read src/foo.ts", "Bash npm test". */
export function summarizeToolInput(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? (input as Record<string, unknown>) : {}) as Record<string, unknown>
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'NotebookRead':
      return `${name} ${baseName(i['file_path'] ?? i['notebook_path'] ?? i['path'])}`.trim()
    case 'Bash':
      return `Bash ${short(i['description'] ?? i['command'], 90)}`
    case 'Grep':
      return `Grep ${short(i['pattern'], 50)}${i['path'] ? ' in ' + baseName(i['path']) : ''}`
    case 'Glob':
      return `Glob ${short(i['pattern'], 60)}`
    case 'Agent':
    case 'Task':
      return `${name} ${short(i['description'] ?? i['name'] ?? i['prompt'], 70)}${i['subagent_type'] ? ` (${String(i['subagent_type'])})` : ''}`
    case 'Skill':
      return `Skill ${short(i['skill'] ?? i['name'], 60)}${i['args'] ? ' ' + short(i['args'], 30) : ''}`
    case 'WebFetch':
      return `WebFetch ${short(i['url'], 80)}`
    case 'WebSearch':
      return `WebSearch ${short(i['query'], 80)}`
    case 'SendMessage':
      return `SendMessage → ${short(i['to'] ?? i['recipient'], 30)}`
    case 'ToolSearch':
      return `ToolSearch ${short(i['query'], 60)}`
    case 'AskUserQuestion':
      return 'AskUserQuestion'
    case 'Workflow':
      return `Workflow ${short(i['name'] ?? i['scriptPath'] ?? 'inline script', 60)}`
    default: {
      const firstStr = Object.values(i).find((v) => typeof v === 'string')
      return `${name}${firstStr ? ' ' + short(firstStr, 60) : ''}`
    }
  }
}

export function skillNameFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const s = i['skill'] ?? i['name']
  return typeof s === 'string' ? s : undefined
}
