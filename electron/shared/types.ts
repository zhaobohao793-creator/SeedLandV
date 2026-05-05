export type GenerationMode =
  | 'text-to-video'
  | 'image-to-video'
  | 'first-last-frame'
  | 'multi-reference'

export type AssetKind = 'image' | 'video' | 'audio'

export type AssetSource =
  | { kind: AssetKind; mode: 'local'; path: string; name: string; sizeBytes: number }
  | { kind: AssetKind; mode: 'url'; url: string }

export type Resolution = '480p' | '720p' | '1080p'
export type Ratio =
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '21:9'
  | '1:1'
  | 'adaptive'

export type ModelId =
  | 'doubao-seedance-2-0-260128'
  | 'doubao-seedance-2-0-fast-260128'

export type ModelChannel = 'ark'

export type ModelCategory = 'video-gen'

export interface ModelMeta {
  id: ModelId
  label: string
  sublabel: string
  channel: ModelChannel
  category: ModelCategory
  modes: GenerationMode[]
  resolutions: Resolution[]
}

const VIDEO_GEN_ARK: GenerationMode[] = [
  'text-to-video',
  'image-to-video',
  'first-last-frame',
  'multi-reference'
]

export const MODELS: ModelMeta[] = [
  {
    id: 'doubao-seedance-2-0-260128',
    label: 'Seedance 2.0',
    sublabel: 'Ark · 标准质量',
    channel: 'ark',
    category: 'video-gen',
    modes: VIDEO_GEN_ARK,
    resolutions: ['480p', '720p', '1080p']
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    label: 'Seedance Fast',
    sublabel: 'Ark · 极速出片',
    channel: 'ark',
    category: 'video-gen',
    modes: VIDEO_GEN_ARK,
    resolutions: ['480p', '720p']
  }
]

export function metaOf(model: ModelId): ModelMeta {
  const m = MODELS.find((x) => x.id === model)
  if (!m) throw new Error(`unknown model: ${model}`)
  return m
}
export function channelOf(model: ModelId): ModelChannel {
  return metaOf(model).channel
}
export function modesOf(model: ModelId): GenerationMode[] {
  return metaOf(model).modes
}
export function categoryOf(model: ModelId): ModelCategory {
  return metaOf(model).category
}
export function resolutionsOf(model: ModelId): Resolution[] {
  return metaOf(model).resolutions
}

export interface GenerationParams {
  model: ModelId
  resolution: Resolution
  ratio: Ratio
  duration: number
  watermark: boolean
  generateAudio: boolean
  returnLastFrame: boolean
  seed?: number
}

export interface SubmitTaskInput {
  mode: GenerationMode
  prompt: string
  assets: AssetSource[]
  params: GenerationParams
}

export type TaskStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'mirroring'
  | 'completed'
  | 'completed_partial'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface TaskRecord {
  serverId: string
  id: string
  localId: string
  mode: GenerationMode
  prompt: string
  params: GenerationParams
  assetsPreview: Array<{ kind: AssetKind; label: string }>
  status: TaskStatus
  videoUrl?: string
  lastFrameUrl?: string
  error?: { message: string; raw?: string }
  createdAt: number
  updatedAt: number
  usage?: { completion_tokens?: number; total_tokens?: number }
}

export interface ApiStatus {
  ark: { hasKey: boolean }
}

export interface AuthState {
  loggedIn: boolean
  email?: string
  tenantId?: string
}

declare global {
  interface Window {
    seedland: {
      // Auth
      getAuthState: () => Promise<AuthState>
      login: (email: string, password: string) => Promise<AuthState | { error: string }>
      register: (
        email: string,
        password: string,
        tenantName?: string
      ) => Promise<AuthState | { error: string }>
      logout: () => Promise<void>
      // Tenant Ark Key
      setArkKey: (key: string) => Promise<{ ok: true } | { error: string }>
      getArkKeyStatus: () => Promise<{ hasKey: boolean }>
      // Tasks (existing surface)
      getApiStatus: () => Promise<ApiStatus>
      submitTask: (
        input: SubmitTaskInput
      ) => Promise<{ localId: string } | { error: string }>
      cancelTask: (serverId: string) => Promise<void>
      removeTask: (serverId: string) => Promise<void>
      listTasks: () => Promise<TaskRecord[]>
      clearTasks: () => Promise<void>
      pickFile: (
        kind: AssetKind,
        allowedExts?: string[]
      ) => Promise<{ path: string; name: string; sizeBytes: number } | null>
      getDroppedPath: (file: File) => string
      downloadVideo: (url: string, suggestedName: string) => Promise<string | null>
      openExternal: (url: string) => Promise<void>
      onTaskUpdate: (cb: (task: TaskRecord) => void) => () => void
    }
  }
}
