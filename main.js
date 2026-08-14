const { app, BrowserWindow, shell, Menu, screen } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

// Configurable via environment so the app can be published and reused:
//   DSH_HARNESS_DIR  path to the deepseek-harness checkout (default ~/deepseek-harness)
//   DSH_PORT         port the harness web UI serves on (default 3080)
//   DSH_DESKTOP_DEBUG=1  extra diagnostics: screenshot + DOM dump to /tmp
const HARNESS_DIR = process.env.DSH_HARNESS_DIR || path.join(os.homedir(), 'deepseek-harness')
const PORT = Number(process.env.DSH_PORT) || 3080
const DEFAULT_WIDTH = 1400
const DEFAULT_HEIGHT = 900
const UI_URL = `http://127.0.0.1:${PORT}/`
const BOOT_TIMEOUT_S = 120

// Black-window fix on Wayland/Intel: GPU compositing renders nothing there,
// so fall back to software rendering for the whole app.
app.disableHardwareAcceleration()

let dshProcess = null
let mainWindow = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// The webserver accepts TCP as soon as it binds, before the plugin tree
// (RPC gateway, client routes) is fully mounted; loading the SPA that early
// leaves it on an empty dark shell. Poll for a real HTTP 200 instead.
function httpReady() {
  return fetch(UI_URL, { method: 'GET', signal: AbortSignal.timeout(2000) })
    .then((res) => res.status === 200)
    .catch(() => false)
}

async function startHarness() {
  if (await httpReady()) {
    console.log('[dsh-desktop] harness already running, attaching to port', PORT)
    return
  }
  // Prefer the built CLI (boots ~2x faster); fall back to tsx source mode.
  const builtBin = path.join(HARNESS_DIR, 'apps', 'cli', 'lib', 'bin.js')
  const args = fs.existsSync(builtBin)
    ? [builtBin, 'web']
    : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web']
  dshProcess = spawn('node', args, {
    cwd: HARNESS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dshProcess.stdout.on('data', (data) => console.log('[dsh]', String(data).trim()))
  dshProcess.stderr.on('data', (data) => console.error('[dsh]', String(data).trim()))
  dshProcess.on('exit', (code) => {
    console.log('[dsh] exited with code', code)
    dshProcess = null
  })
  const deadline = Date.now() + BOOT_TIMEOUT_S * 1000
  while (Date.now() < deadline) {
    if (dshProcess === null || dshProcess.exitCode !== null) break
    if (await httpReady()) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`dsh web did not become ready on port ${PORT} within ${BOOT_TIMEOUT_S}s`)
}

// Self-healing loop: the SPA races server readiness (plugins mount after the
// webserver binds), which shows as an empty shell or a "Failed to load
// plugins" banner. Reload until the UI reports healthy.
function attachHealthLoop() {
  let healthChecks = 0
  const healthTimer = setInterval(async () => {
    if (mainWindow === null) {
      clearInterval(healthTimer)
      return
    }
    try {
      const state = await mainWindow.webContents.executeJavaScript(`JSON.stringify({
        root: document.getElementById('root')?.children.length ?? -1,
        text: document.body.innerText.slice(0, 300),
      })`)
      const { root, text } = JSON.parse(state)
      const broken = root < 1 || /failed to load plugins|did not activate/i.test(text)
      if (!broken) {
        clearInterval(healthTimer)
        console.log('[dsh-desktop] UI healthy')
      } else if (healthChecks < 10) {
        healthChecks++
        console.log('[dsh-desktop] unhealthy shell, reloading (attempt', healthChecks + ')')
        mainWindow.webContents.reload()
      } else {
        clearInterval(healthTimer)
        console.error('[dsh-desktop] UI still unhealthy after', healthChecks, 'reloads')
      }
    } catch {
      // Page mid-navigation; check again next tick.
    }
  }, 5000)
}

function createWindow() {
  // The requested size may exceed the work area on small/fractionally-scaled
  // screens; the WM then clamps the height, making the window look off.
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(DEFAULT_WIDTH, workArea.width - 40)
  const height = Math.min(DEFAULT_HEIGHT, workArea.height - 40)
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#101014',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  mainWindow.center()
  mainWindow.loadFile(path.join(__dirname, 'splash.html'))
  mainWindow.webContents.on('did-finish-load', () => {
    // Only diagnose the real UI page, not the splash.
    if (mainWindow.webContents.getURL() !== UI_URL) return
    console.log('[dsh-desktop] page loaded')
    if (process.env.DSH_DESKTOP_DEBUG === '1') {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage()
          fs.writeFileSync('/tmp/dsh-window.png', image.toPNG())
          console.log('[dsh-desktop] screenshot saved')
        } catch (error) {
          console.error('[dsh-desktop] screenshot failed:', error.message)
        }
        try {
          const dom = await mainWindow.webContents.executeJavaScript(
            `JSON.stringify({
              readyState: document.readyState,
              rootChildren: document.getElementById('root')?.children.length ?? -1,
              bodyText: (document.body.innerText || '').slice(0, 200),
              scrollH: document.documentElement.scrollHeight,
              outerW: window.outerWidth, outerH: window.outerHeight,
              innerW: window.innerWidth, innerH: window.innerHeight,
              dpr: window.devicePixelRatio,
              screenW: screen.width, screenH: screen.height,
            })`,
          )
          console.log('[dsh-desktop] DOM:', dom)
        } catch (error) {
          console.error('[dsh-desktop] DOM inspect failed:', error.message)
        }
      }, 8000)
    }
  })
  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.error('[dsh-desktop] page failed to load:', code, desc)
  })
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[dsh-desktop] renderer gone:', details.reason)
  })
  mainWindow.webContents.on('console-message', (event, level, message) => {
    const lvl = event?.level ?? level
    const msg = event?.message ?? message
    if (lvl === 'error' || lvl === 3 || lvl === 'warning' || lvl === 2) {
      console.log('[page]', lvl, msg)
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return
    event.preventDefault()
    shell.openExternal(url)
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  createWindow() // shows the splash immediately
  try {
    await startHarness()
  } catch (error) {
    console.error('[dsh-desktop]', error.message)
    app.quit()
    return
  }
  console.log('[dsh-desktop] harness ready, loading UI')
  mainWindow.loadURL(UI_URL)
  attachHealthLoop()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => {
  if (dshProcess !== null) dshProcess.kill()
})
