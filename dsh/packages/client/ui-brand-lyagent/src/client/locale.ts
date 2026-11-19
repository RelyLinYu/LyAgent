/** Deployment identity copy. Upstream component licenses remain in the package LICENSE and THIRD_PARTY_NOTICES files. */
export const NS = 'lyagent.brand'

/** English fallback dictionary. */
export const en = {
  name: 'LyAgent',
  initials: 'LY',
  attribution: 'LyAgent - open agent orchestration platform',
  settings: 'Settings',
}

/** Simplified Chinese dictionary with the same keys. */
export const zh = {
  name: 'LyAgent',
  initials: 'LY',
  attribution: 'LyAgent - 开源 Agent 编排平台',
  settings: '设置',
} satisfies Record<keyof typeof en, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Deployment identity and upstream attribution. */
    'lyagent.brand': keyof typeof en
  }
}
