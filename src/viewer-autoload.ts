const WARM_ACTIONS = ['86_Talking', '88_Thinking'] as const

export type ClawatarViewerConfig = {
  character?: {
    id?: string
    name?: string
    mood?: string
  }
  model?: {
    url?: string
    autoLoad?: boolean
  }
  server?: {
    vitePort?: number
    wsPort?: number
    audioPort?: number
    bridgePort?: number
  }
}

let cachedConfig: ClawatarViewerConfig | null = null

export async function loadViewerConfig(): Promise<ClawatarViewerConfig> {
  if (cachedConfig) return cachedConfig
  try {
    const resp = await fetch('./clawatar.config.json')
    if (resp.ok) {
      cachedConfig = await resp.json()
      return cachedConfig ?? {}
    }
  } catch {}
  cachedConfig = {}
  return cachedConfig
}

export async function resolveAutoLoadModelURL(): Promise<string> {
  const config = await loadViewerConfig()
  const configModelUrl = config.model?.url || ''
  const configAutoLoad = config.model?.autoLoad !== false

  if (!configAutoLoad) return ''

  const savedUrl = localStorage.getItem('vrm-model-url') || ''
  return configModelUrl || savedUrl
}

export function persistModelURL(modelUrl: string): void {
  if (!modelUrl) return
  localStorage.setItem('vrm-model-url', modelUrl)
}

export function warmConversationActions(
  preloadAction: (actionId: string) => Promise<unknown>
): void {
  window.setTimeout(() => {
    void Promise.allSettled(WARM_ACTIONS.map((actionId) => preloadAction(actionId)))
  }, 250)
}
