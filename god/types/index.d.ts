// The engine state contract of the orangu-god plugin: the names and the JSON shapes of the values that its pane
// keeps in `$.state`. The engine validator reads the names here. The code of the plugin (src/god/state.tsx) gives
// each value its full type, and no other plugin depends on these values.

/** The board snapshot of the god pane, as plain JSON. */
export type OranguGodBoard = { readonly [field: string]: unknown }

declare module 'claude-code' {
  interface PluginState {
    /** the values of the god pane in the engine state */
    'orangu-god': {
      /** the last board snapshot, null before the first one */
      board: OranguGodBoard | null
      /** the key of the selected row, '' for none */
      selected: string
      /** the keys of the groups that the person opened */
      openGroups: readonly string[]
      /** the color set of the session theme */
      theme: 'dark' | 'light' | 'theme-keys'
      /** the open tab of the detail, the first line of its content, and whether the narrow pane shows the detail */
      detail: { tab: 'now' | 'history' | 'agents' | 'screen' | 'recap'; scroll: number; isOpen: boolean }
    }
  }
}
