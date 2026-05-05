import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import dotenv from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import type {
  ApiStatus,
  AssetKind,
  CreateEmployeeInput,
  SubmitTaskInput,
  UpdateEmployeeInput
} from '@shared/types'
import { Http } from './api/http'
import { Auth, type AuthState } from './api/auth'
import { ApiClient } from './api/client'
import { TaskSocket } from './api/socket'

function loadEnv() {
  const candidates = is.dev
    ? [path.join(process.cwd(), '.env'), path.join(app.getAppPath(), '.env')]
    : [
        path.join(path.dirname(app.getPath('exe')), '.env'),
        path.join(process.resourcesPath, '.env')
      ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p })
      return
    }
  }
}

let mainWindow: BrowserWindow | null = null
let http: Http
let auth: Auth
let api: ApiClient
let socket: TaskSocket

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    title: 'SeedLand · V',
    backgroundColor: '#070B14',
    titleBarStyle: 'hiddenInset',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  loadEnv()
  electronApp.setAppUserModelId('com.seedland.seedlandv')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  const baseUrl = process.env.SEEDLANDV_API_URL || 'http://localhost:8000'
  http = new Http(baseUrl, () => auth.getToken())
  auth = new Auth(http)
  api = new ApiClient(http, auth)
  socket = new TaskSocket(baseUrl, auth, (task) => {
    mainWindow?.webContents.send('task:update', task)
  })

  auth.bootstrap()
  registerIpc()
  createWindow()

  socket.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  socket?.stop()
})

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

function registerIpc() {
  ipcMain.handle('auth:state', (): AuthState => auth.state())

  ipcMain.handle('auth:bootstrapStatus', async () => {
    try {
      return await auth.getBootstrapStatus()
    } catch (err) {
      // If we can't reach the API, assume initialized so the renderer at
      // least shows the login form rather than a misleading bootstrap form.
      console.warn('[auth:bootstrapStatus]', (err as Error).message)
      return { initialized: true }
    }
  })

  ipcMain.handle(
    'auth:login',
    async (
      _e,
      employeeId: string,
      password: string
    ): Promise<AuthState | { error: string }> => {
      try {
        const st = await auth.login(employeeId, password)
        socket.rebind()
        return st
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'auth:bootstrap',
    async (
      _e,
      workshopName: string,
      employeeId: string,
      password: string,
      displayName?: string
    ): Promise<AuthState | { error: string }> => {
      try {
        const st = await auth.bootstrapInitial(
          workshopName,
          employeeId,
          password,
          displayName
        )
        socket.rebind()
        return st
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('auth:logout', async () => {
    await auth.logout()
    socket.rebind()
  })

  ipcMain.handle('admin:listEmployees', async () => {
    try {
      return await api.listEmployees()
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'admin:createEmployee',
    async (_e, input: CreateEmployeeInput) => {
      try {
        return await api.createEmployee(input)
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'admin:updateEmployee',
    async (_e, userId: string, patch: UpdateEmployeeInput) => {
      try {
        return await api.updateEmployee(userId, patch)
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('admin:deactivateEmployee', async (_e, userId: string) => {
    try {
      return await api.deactivateEmployee(userId)
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('tenant:setArkKey', async (_e, key: string): Promise<{ ok: true } | { error: string }> => {
    try {
      await api.setArkKey(key)
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('tenant:arkKeyStatus', async (): Promise<{ hasKey: boolean }> => {
    try {
      return await api.getArkKeyStatus()
    } catch {
      return { hasKey: false }
    }
  })

  ipcMain.handle('api:status', async (): Promise<ApiStatus> => {
    try {
      const { hasKey } = await api.getArkKeyStatus()
      return { ark: { hasKey } }
    } catch {
      return { ark: { hasKey: false } }
    }
  })

  ipcMain.handle('api:listTasks', async () => {
    try {
      return await api.listTasks()
    } catch (err) {
      console.warn('[api:listTasks]', (err as Error).message)
      return []
    }
  })

  ipcMain.handle('api:clearTasks', () => {
    // UI-only state lives in renderer; nothing to clear server-side without an explicit delete.
  })

  ipcMain.handle('api:cancel', async (_e, serverId: string) => {
    if (!serverId) return
    try {
      await api.cancelTask(serverId)
    } catch (err) {
      console.warn('[api:cancel]', (err as Error).message)
    }
  })

  ipcMain.handle('api:removeTask', async (_e, serverId: string) => {
    if (!serverId) return
    try {
      await api.cancelTask(serverId)
    } catch (err) {
      console.warn('[api:removeTask]', (err as Error).message)
    }
  })

  ipcMain.handle(
    'api:pickFile',
    async (_e, kind: AssetKind, allowedExts?: string[]) => {
      const defaults: Record<AssetKind, { name: string; exts: string[] }> = {
        image: { name: 'Images', exts: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] },
        video: { name: 'Videos', exts: ['mp4', 'mov', 'webm', 'mkv'] },
        audio: { name: 'Audio', exts: ['mp3', 'wav', 'm4a', 'aac'] }
      }
      const d = defaults[kind]
      const filters = [
        { name: d.name, extensions: allowedExts && allowedExts.length ? allowedExts : d.exts }
      ]
      const res = await dialog.showOpenDialog({ properties: ['openFile'], filters })
      if (res.canceled || !res.filePaths[0]) return null
      const p = res.filePaths[0]
      return { path: p, name: path.basename(p), sizeBytes: fileSize(p) }
    }
  )

  ipcMain.handle('api:downloadVideo', async (_e, url: string, suggestedName: string) => {
    // Filter follows suggestedName extension so the same IPC handles both the
    // mirrored video (.mp4) and the mirrored last-frame (.png).
    const ext = (suggestedName.split('.').pop() || 'mp4').toLowerCase()
    const filterName = ext.toUpperCase()
    const res = await dialog.showSaveDialog({
      defaultPath: suggestedName,
      filters: [{ name: filterName, extensions: [ext] }]
    })
    if (res.canceled || !res.filePath) return null

    // macOS Save Dialog appends the filter extension when the typed filename
    // ends in a different extension (e.g. MP4 filter + name "x.png" produces
    // "x.png.mp4"). Strip a single trailing mismatched extension and ensure
    // the path ends with the requested ext.
    const wanted = `.${ext}`
    let savePath = res.filePath
    if (!savePath.toLowerCase().endsWith(wanted)) {
      const trailing = path.extname(savePath)
      if (trailing) savePath = savePath.slice(0, -trailing.length)
      if (!savePath.toLowerCase().endsWith(wanted)) savePath = `${savePath}${wanted}`
    }
    const win = mainWindow
    if (!win) return null

    return new Promise<string | null>((resolve) => {
      session.defaultSession.once('will-download', (_ev, item) => {
        item.setSavePath(savePath)
        item.once('done', (_e2, state) => resolve(state === 'completed' ? savePath : null))
      })
      win.webContents.downloadURL(url)
    })
  })

  ipcMain.handle('api:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle(
    'api:submit',
    async (_e, input: SubmitTaskInput): Promise<{ localId: string } | { error: string }> => {
      if (!auth.getToken()) return { error: '未登录' }
      try {
        return await api.submitTask(input)
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )
}
