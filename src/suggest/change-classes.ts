/**
 * Canonical improvement surfaces shared by the browser report, deterministic catalog, and plugin.
 * Keep this module platform-neutral: it must remain safe to import in the browser bundle.
 */
export const CHANGE_CLASS_DEFINITIONS = [
  { id: 'instruction', label: 'Instruction files', description: 'Persistent project guidance and conventions.' },
  { id: 'script-cli', label: 'Scripts and CLIs', description: 'Repeatable actions with checkable output.' },
  { id: 'hook', label: 'Hooks', description: 'Guaranteed actions at lifecycle boundaries.' },
  { id: 'skill-create', label: 'Skills to create', description: 'Reusable knowledge and workflows specific to this setup.' },
  { id: 'skill-discover', label: 'Skills to discover', description: 'Existing capabilities to evaluate before installing.' },
  { id: 'subagent-agent', label: 'Subagents and agents', description: 'Isolated or specialized work with clear ownership.' },
  { id: 'mcp', label: 'MCP servers', description: 'External tools and data the work actually needs.' },
  { id: 'plugin', label: 'Plugins', description: 'A reusable package of related extensions.' },
  { id: 'workflow-config', label: 'Workflow and configuration', description: 'How work is sequenced, checked, and repeated.' },
] as const

export type ChangeClass = (typeof CHANGE_CLASS_DEFINITIONS)[number]['id']

const CHANGE_CLASSES: ReadonlySet<string> = new Set(CHANGE_CLASS_DEFINITIONS.map((definition) => definition.id))

export function isChangeClass(value: string): value is ChangeClass {
  return CHANGE_CLASSES.has(value)
}
