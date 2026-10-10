// The engine state contract of the orangu-god plugin: the names and the JSON shapes of the values that its pane
// keeps in `$.state`. The engine validator reads the names here. The code of the plugin (src/god/state.tsx) gives
// each value its full type, and no other plugin depends on these values.

/** The board snapshot of the god pane, as plain JSON. */
export type OranguGodBoard = { readonly [field: string]: unknown }

/** 1 value of the key path (an intent, an outcome, the check after a send), as plain JSON. */
export type OranguGodDeliverValue = { readonly [field: string]: unknown }

/** The Recap of 1 session, as plain JSON: running, answered with its model text and tokens, or failed with its reason. */
export type OranguGodRecap = { readonly [field: string]: unknown }

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
      /** the screen state of the Screen tab: the session, the last good read of its screen, and whether the newest read failed */
      screen: { sessionId: string; read?: { sessionId: string; workspaceRef: string; surfaceRef: string; text: string; readAt: number }; isFailed: boolean } | null
      /** the note of the last j that did not jump: the session and the reason */
      jump: { sessionId: string; reason: 'no-tab' | 'failed' } | null
      /** the key path: the intent of the confirm bar and its scroll, the draft of r or m, the last outcome, the check of the refreshes after a send, and whether the keys go out now */
      deliver: {
        intent?: OranguGodDeliverValue
        scroll: number
        draft?: { kind: 'prompt' | 'peer'; target: { sessionId: string; name: string }; lines: readonly string[] }
        outcome?: OranguGodDeliverValue
        check?: OranguGodDeliverValue
        isSending?: boolean
      }
      /** the times of the last alert and the last done tone of each session in the last 5 min */
      alerts: { alertAt: { readonly [sessionId: string]: number }; doneAt: { readonly [sessionId: string]: number } }
      /** the last Recap, of any session, null before the first x */
      recap: OranguGodRecap | null
    }
  }
}
