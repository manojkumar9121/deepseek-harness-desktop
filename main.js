const { app, BrowserWindow, shell, Menu, screen, dialog } = require('electron')
const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { refreshOpenRouterCatalog, refreshNvidiaCatalog, readEnvFile } = require('./scripts/refresh-openrouter-models')

// Configurable via environment so the app can be published and reused:
//   DSH_HARNESS_DIR  path to the deepseek-harness checkout (default bundled or ~/deepseek-harness)
//   DSH_PORT         port the harness web UI serves on (default 3080)
//   DSH_DESKTOP_DEBUG=1  extra diagnostics: screenshot + DOM dump to /tmp
const HARNESS_DIR = process.env.DSH_HARNESS_DIR || (app.isPackaged ? path.join(process.resourcesPath, 'harness') : path.join(os.homedir(), 'deepseek-harness'))
const PORT = Number(process.env.DSH_PORT) || 3080
const DEFAULT_WIDTH = 1400
const DEFAULT_HEIGHT = 900
const APP_ICON = path.join(__dirname, 'build', 'icon.png')
const UI_ORIGIN = new URL(`http://127.0.0.1:${PORT}/`).origin
let uiUrl = `${UI_ORIGIN}/`
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

function redactTokens(value) {
  return String(value).replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>')
}

function isUiUrl(value) {
  try {
    return new URL(value).origin === UI_ORIGIN
  } catch {
    return false
  }
}

function getHttpStatus(url) {
  return fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(2000) })
    .then((res) => res.status)
    .catch(() => 0)
}

function launchUrlFromLine(line) {
  const match = line.match(/https?:\/\/[^\s]+/)
  if (match === null) return null
  try {
    const candidate = new URL(match[0])
    if (candidate.origin !== UI_ORIGIN || !candidate.searchParams.has('token')) return null
    return candidate.toString()
  } catch {
    return null
  }
}

async function startHarness() {
  const configuredUrl = process.env.DSH_UI_URL
  if (configuredUrl) {
    const candidate = new URL(configuredUrl)
    if (candidate.origin !== UI_ORIGIN) {
      throw new Error(`DSH_UI_URL must use ${UI_ORIGIN}, received ${candidate.origin}`)
    }
    const status = await getHttpStatus(candidate)
    if (status !== 200 && status !== 303) {
      throw new Error(`DSH_UI_URL is not ready (HTTP ${status || 'no response'})`)
    }
    console.log('[dsh-desktop] harness already running, attaching to configured URL')
    return candidate.toString()
  }

  const baseStatus = await getHttpStatus(`${UI_ORIGIN}/`)
  if (baseStatus !== 0) {
    throw new Error(`port ${PORT} is already serving an authenticated Harness; set DSH_UI_URL to its full launch URL including token`)
  }

  const nvidiaEnvFile = process.env.DSH_API_KEYS_DIR
    ? path.join(process.env.DSH_API_KEYS_DIR, 'nvidia.env')
    : path.join(os.homedir(), 'Documents', 'api keys', 'nvidia.env')
  const nvidiaCreds = readEnvFile(nvidiaEnvFile)
  const nvidiaKey = nvidiaCreds.nvidia ?? ''
  if (nvidiaKey) process.env.NVIDIA_API_KEY = nvidiaKey

  const builtBins = [
    path.join(HARNESS_DIR, 'apps', 'cli', 'lib', 'bin.js'),
    path.join(HARNESS_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
  const builtBin = builtBins.find((candidate) => fs.existsSync(candidate))
  if (builtBin === undefined && app.isPackaged) {
    throw new Error(`packaged DeepSeek Harness runtime is missing under ${HARNESS_DIR}`)
  }
  const webArgs = ['web', '--host', '127.0.0.1', '--port', String(PORT), '--no-open']
  const args = builtBin === undefined
    ? ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...webArgs]
    : [builtBin, ...webArgs]
  const nodeBin = app.isPackaged ? process.execPath : 'node'
  const env = app.isPackaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined
  dshProcess = spawn(nodeBin, args, {
    cwd: HARNESS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })

  let launchUrl = null
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let spawnError = null
  let exitCode = null
  let exitSignal = null
  const consume = (line) => {
    const found = launchUrlFromLine(line)
    if (found !== null) launchUrl = found
  }
  dshProcess.stdout.on('data', (data) => {
    stdoutBuffer += String(data)
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      consume(line)
      console.log('[dsh]', redactTokens(line))
    }
  })
  dshProcess.stderr.on('data', (data) => {
    stderrBuffer += String(data)
    const lines = stderrBuffer.split(/\r?\n/)
    stderrBuffer = lines.pop() ?? ''
    for (const line of lines) console.error('[dsh]', redactTokens(line))
  })
  dshProcess.once('error', (error) => {
    spawnError = error
  })
  dshProcess.on('exit', (code, signal) => {
    exitCode = code
    exitSignal = signal
    if (stdoutBuffer) {
      consume(stdoutBuffer)
      console.log('[dsh]', redactTokens(stdoutBuffer))
    }
    if (stderrBuffer) console.error('[dsh]', redactTokens(stderrBuffer))
    console.log('[dsh] exited with code', code)
    dshProcess = null
  })

  const deadline = Date.now() + BOOT_TIMEOUT_S * 1000
  while (Date.now() < deadline) {
    if (spawnError !== null) throw spawnError
    if (dshProcess === null || dshProcess.exitCode !== null) break
    if (launchUrl !== null && [200, 303].includes(await getHttpStatus(launchUrl))) return launchUrl
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (dshProcess === null) {
    const status = exitSignal === null ? `code ${exitCode}` : `signal ${exitSignal}`
    throw new Error(`dsh web exited before becoming ready (${status})`)
  }
  throw new Error(`dsh web did not become ready on port ${PORT} within ${BOOT_TIMEOUT_S}s`)
}

function executeJavaScriptWithTimeout(webContents, source, timeoutMs = 2000) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('renderer health check timed out')), timeoutMs)
  })
  return Promise.race([webContents.executeJavaScript(source), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

// Self-healing loop: the SPA races server readiness (plugins mount after the
// webserver binds), which shows as an empty shell or a "Failed to load
// plugins" banner. Wait through normal initialization and reload only an
// explicit plugin failure.
function attachHealthLoop() {
  const window = mainWindow
  if (window === null) return
  const startedAt = Date.now()
  let reloads = 0
  let waitingLogged = false
  let stopped = false
  let timer = null

  const stop = () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  window.once('closed', stop)
  window.webContents.once('render-process-gone', stop)
  window.webContents.once('destroyed', stop)

  async function check() {
    if (stopped || window.isDestroyed() || mainWindow !== window) {
      stop()
      return
    }
    const elapsed = Date.now() - startedAt
    if (elapsed >= 60000) {
      stop()
      console.error('[dsh-desktop] UI did not become healthy after 60s')
      return
    }
    try {
      const state = await executeJavaScriptWithTimeout(window.webContents, `JSON.stringify({
        root: document.getElementById('root')?.children.length ?? -1,
        booting: document.querySelector('[data-dsh-boot]') !== null,
        text: document.body.innerText.slice(0, 300),
      })`)
      if (Date.now() - startedAt >= 60000) {
        stop()
        console.error('[dsh-desktop] UI did not become healthy after 60s')
        return
      }
      const { root, booting, text } = JSON.parse(state)
      const pluginError = /failed to load plugins|did not activate/i.test(text)
      if (!pluginError && !booting && root >= 1) {
        const healthyAfter = Date.now() - startedAt
        stop()
        console.log('[dsh-desktop] UI healthy after', healthyAfter, 'ms')
        return
      }
      if (pluginError && reloads < 2) {
        reloads++
        waitingLogged = false
        console.log('[dsh-desktop] plugin load failed, reloading (attempt', reloads + ')')
        window.webContents.reload()
        timer = setTimeout(check, 2000)
        return
      }
      if (!waitingLogged && elapsed >= 2000) {
        console.log('[dsh-desktop] waiting for Harness plugins to mount')
        waitingLogged = true
      }
    } catch {
      if (Date.now() - startedAt >= 60000) {
        stop()
        console.error('[dsh-desktop] UI health checks failed for 60s')
        return
      }
    }
    if (!stopped) timer = setTimeout(check, 500)
  }

  void check()
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
    icon: APP_ICON,
    backgroundColor: '#101014',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  mainWindow.maximize()
  mainWindow.loadFile(path.join(__dirname, 'splash.html'))
  mainWindow.webContents.on('did-finish-load', () => {
    // Only diagnose the real UI page, not the splash.
    if (!isUiUrl(mainWindow.webContents.getURL())) return
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
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message } = event
    if (level === 'warning' || level === 'error') {
      console.log('[page]', level, message)
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isUiUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  createWindow() // shows the splash immediately
  // Fresh OpenRouter models land in pi-ai's static catalog only at release
  // time; patch it before the harness boots so the picker sees new ids every
  // launch. Dev mode only: the packaged production runtime is immutable.
  if (!app.isPackaged && process.env.DSH_REFRESH_MODELS === '1') {
    try {
      await refreshOpenRouterCatalog(HARNESS_DIR, console.log)
    } catch (error) {
      console.warn('[dsh-desktop] openrouter catalog refresh skipped:', error.message)
    }
    // NVIDIA catalog: read the NVAPI key from the user's api-keys dir.
    const envFile = process.env.DSH_API_KEYS_DIR
      ? path.join(process.env.DSH_API_KEYS_DIR, 'nvidia.env')
      : path.join(os.homedir(), 'Documents', 'api keys', 'nvidia.env')
    const env = readEnvFile(envFile)
    const nvidiaKey = env.nvidia ?? ''
    if (nvidiaKey) {
      try {
        await refreshNvidiaCatalog(HARNESS_DIR, console.log, nvidiaKey)
      } catch (error) {
        console.warn('[dsh-desktop] nvidia catalog refresh skipped:', error.message)
      }
    }
  }
  try {
    uiUrl = await startHarness()
  } catch (error) {
    const details = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error('[dsh-desktop]', details)
    dialog.showErrorBox('DeepSeek Harness failed to start', details)
    app.quit()
    return
  }
  console.log('[dsh-desktop] harness ready, loading UI')
  if (mainWindow !== null) {
    mainWindow.loadURL(uiUrl).catch((error) => {
      console.error('[dsh-desktop] failed to load UI:', error)
      dialog.showErrorBox('DeepSeek Harness failed to load', error.message)
      app.quit()
    })
    attachHealthLoop()
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length !== 0) return
    createWindow()
    if (uiUrl.includes('token=')) {
      mainWindow.loadURL(uiUrl)
      attachHealthLoop()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => {
  if (dshProcess !== null) dshProcess.kill()
})
