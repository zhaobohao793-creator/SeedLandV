import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Sidebar from './components/layout/Sidebar'
import Topbar from './components/layout/Topbar'
import GridBackground from './components/effects/GridBackground'
import TaskQueue from './components/tasks/TaskQueue'
import AuthGate from './components/auth/AuthGate'
import ArkKeyPrompt from './components/auth/ArkKeyPrompt'
import TextToVideo from './modes/TextToVideo'
import ImageToVideo from './modes/ImageToVideo'
import FirstLastFrame from './modes/FirstLastFrame'
import MultiReference from './modes/MultiReference'
import { useAppStore } from './lib/store'

const pages = {
  'text-to-video': TextToVideo,
  'image-to-video': ImageToVideo,
  'first-last-frame': FirstLastFrame,
  'multi-reference': MultiReference
}

export default function App() {
  const currentMode = useAppStore((s) => s.currentMode)
  const authState = useAppStore((s) => s.authState)
  const setAuthState = useAppStore((s) => s.setAuthState)
  const apiStatus = useAppStore((s) => s.apiStatus)
  const setApiStatus = useAppStore((s) => s.setApiStatus)
  const arkKeyPromptOpen = useAppStore((s) => s.arkKeyPromptOpen)
  const setArkKeyPromptOpen = useAppStore((s) => s.setArkKeyPromptOpen)
  const mergeTask = useAppStore((s) => s.mergeTask)
  const setTasks = useAppStore((s) => s.setTasks)

  // Bootstrap auth state once on mount.
  useEffect(() => {
    window.seedland.getAuthState().then(setAuthState)
  }, [setAuthState])

  // Once logged in, fetch tasks + Ark key status, and listen for live updates.
  useEffect(() => {
    if (!authState.loggedIn) return
    window.seedland.getApiStatus().then((s) => {
      setApiStatus(s)
      if (!s.ark.hasKey) setArkKeyPromptOpen(true)
    })
    window.seedland.listTasks().then(setTasks)
    const off = window.seedland.onTaskUpdate((task) => mergeTask(task))
    return off
  }, [authState.loggedIn, setApiStatus, setArkKeyPromptOpen, setTasks, mergeTask])

  if (!authState.loggedIn) return <AuthGate />

  const Page = pages[currentMode]

  return (
    <div className="relative h-screen w-screen overflow-hidden text-text">
      {arkKeyPromptOpen && <ArkKeyPrompt />}
      <GridBackground />
      <div className="relative z-10 flex h-full flex-col">
        <Topbar />
        <div className="flex flex-1 min-h-0">
          <Sidebar />
          <main className="flex-1 min-w-0 overflow-auto px-8 py-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentMode}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="mx-auto max-w-3xl"
              >
                <Page />
              </motion.div>
            </AnimatePresence>
          </main>
          <TaskQueue />
        </div>
      </div>
    </div>
  )
}
