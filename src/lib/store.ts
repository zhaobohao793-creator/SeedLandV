import { create } from 'zustand'
import type {
  ApiStatus,
  AssetSource,
  AuthState,
  GenerationMode,
  GenerationParams,
  ModelId,
  Ratio,
  Resolution,
  TaskRecord
} from '@shared/types'
import { modesOf, resolutionsOf } from '@shared/types'

export const DEFAULT_PARAMS: GenerationParams = {
  model: 'doubao-seedance-2-0-260128',
  resolution: '1080p',
  ratio: '16:9',
  duration: 5,
  watermark: false,
  generateAudio: false,
  returnLastFrame: false
}

interface FormState {
  prompt: string
  orderId: string
  assets: AssetSource[]
  params: GenerationParams
}

interface AppState {
  authState: AuthState
  apiStatus: ApiStatus | null
  arkKeyPromptOpen: boolean
  currentMode: GenerationMode
  tasks: TaskRecord[]
  forms: Record<GenerationMode, FormState>
  setAuthState: (s: AuthState) => void
  setApiStatus: (s: ApiStatus) => void
  setArkKeyPromptOpen: (open: boolean) => void
  setMode: (m: GenerationMode) => void
  setPrompt: (mode: GenerationMode, v: string) => void
  setOrderId: (mode: GenerationMode, v: string) => void
  setAssets: (mode: GenerationMode, a: AssetSource[]) => void
  addAsset: (mode: GenerationMode, a: AssetSource) => void
  removeAsset: (mode: GenerationMode, index: number) => void
  setParams: (mode: GenerationMode, patch: Partial<GenerationParams>) => void
  setModel: (m: ModelId) => void
  setResolution: (mode: GenerationMode, r: Resolution) => void
  setRatio: (mode: GenerationMode, r: Ratio) => void
  setDuration: (mode: GenerationMode, d: number) => void
  setTasks: (t: TaskRecord[]) => void
  mergeTask: (task: TaskRecord) => void
  removeTask: (localId: string) => void
  clearTasks: () => void
}

const emptyForm = (): FormState => ({
  prompt: '',
  orderId: '',
  assets: [],
  params: { ...DEFAULT_PARAMS }
})

export const useAppStore = create<AppState>((set) => ({
  authState: { loggedIn: false },
  apiStatus: null,
  arkKeyPromptOpen: false,
  currentMode: 'text-to-video',
  tasks: [],
  forms: {
    'text-to-video': emptyForm(),
    'image-to-video': emptyForm(),
    'first-last-frame': emptyForm(),
    'multi-reference': emptyForm()
  },
  setAuthState: (s) => set({ authState: s }),
  setApiStatus: (s) => set({ apiStatus: s }),
  setArkKeyPromptOpen: (open) => set({ arkKeyPromptOpen: open }),
  setMode: (m) => set({ currentMode: m }),
  setPrompt: (mode, v) =>
    set((st) => ({
      forms: { ...st.forms, [mode]: { ...st.forms[mode], prompt: v } }
    })),
  setOrderId: (mode, v) =>
    set((st) => ({
      forms: { ...st.forms, [mode]: { ...st.forms[mode], orderId: v } }
    })),
  setAssets: (mode, a) =>
    set((st) => ({
      forms: { ...st.forms, [mode]: { ...st.forms[mode], assets: a } }
    })),
  addAsset: (mode, a) =>
    set((st) => ({
      forms: {
        ...st.forms,
        [mode]: { ...st.forms[mode], assets: [...st.forms[mode].assets, a] }
      }
    })),
  removeAsset: (mode, index) =>
    set((st) => ({
      forms: {
        ...st.forms,
        [mode]: {
          ...st.forms[mode],
          assets: st.forms[mode].assets.filter((_, i) => i !== index)
        }
      }
    })),
  setParams: (mode, patch) =>
    set((st) => ({
      forms: {
        ...st.forms,
        [mode]: { ...st.forms[mode], params: { ...st.forms[mode].params, ...patch } }
      }
    })),
  setModel: (m) =>
    set((st) => {
      const forms: typeof st.forms = { ...st.forms }
      const allowed = resolutionsOf(m)
      ;(Object.keys(forms) as GenerationMode[]).forEach((k) => {
        const cur = forms[k].params.resolution
        const resolution = allowed.includes(cur) ? cur : allowed[allowed.length - 1]
        forms[k] = { ...forms[k], params: { ...forms[k].params, model: m, resolution } }
      })
      const supported = modesOf(m)
      const currentMode = supported.includes(st.currentMode) ? st.currentMode : supported[0]
      return { forms, currentMode }
    }),
  setResolution: (mode, r) =>
    set((st) => ({
      forms: {
        ...st.forms,
        [mode]: { ...st.forms[mode], params: { ...st.forms[mode].params, resolution: r } }
      }
    })),
  setRatio: (mode, r) =>
    set((st) => ({
      forms: {
        ...st.forms,
        [mode]: { ...st.forms[mode], params: { ...st.forms[mode].params, ratio: r } }
      }
    })),
  setDuration: (mode, d) =>
    set((st) => ({
      forms: {
        ...st.forms,
        [mode]: { ...st.forms[mode], params: { ...st.forms[mode].params, duration: d } }
      }
    })),
  setTasks: (t) => set({ tasks: t }),
  mergeTask: (task) =>
    set((st) => {
      const idx = st.tasks.findIndex((x) => x.localId === task.localId)
      if (idx === -1) return { tasks: [task, ...st.tasks] }
      const next = st.tasks.slice()
      next[idx] = task
      return { tasks: next }
    }),
  removeTask: (localId) =>
    set((st) => ({ tasks: st.tasks.filter((t) => t.localId !== localId) })),
  clearTasks: () => set({ tasks: [] })
}))
