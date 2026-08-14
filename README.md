# DeepSeek Harness Desktop

Electron desktop wrapper for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`).

Turns the harness's local web UI into a native window: instant splash screen while the harness server boots, then the full harness interface — sessions, workspace, model picker, MCP servers.

## Why

- No browser tab; the harness is managed as a child process by the app (it is spawned and killed with the app).
- Fixes a startup race where loading the SPA before the harness plugin tree is ready leaves a blank/black window.
- Handles fractional scaling and small screens (window is sized to fit the work area).

## Prerequisites

- **Node.js >= 20** (the harness requires Node 22+ — see its README)
- A **DeepSeek Harness checkout**, built:

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git ~/deepseek-harness
cd ~/deepseek-harness
corepack enable pnpm
pnpm install
pnpm run build   # optional but recommended: built CLI boots ~2x faster
```

## Install & Run

```bash
npm install
npm start
```

That's it. The app spawns `dsh web` (built CLI if present, source mode otherwise), waits for it to be ready, and loads the UI at `http://127.0.0.1:3080/`.

## Configuration

| Environment variable | Default              | Purpose                                  |
| -------------------- | -------------------- | ---------------------------------------- |
| `DSH_HARNESS_DIR`    | `~/deepseek-harness` | Path to the harness checkout             |
| `DSH_PORT`           | `3080`               | Port the harness web UI listens on       |
| `DSH_DESKTOP_DEBUG`  | off                  | `1` dumps DOM + screenshot to `/tmp`     |

Example:

```bash
DSH_HARNESS_DIR=/opt/deepseek-harness DSH_PORT=4000 npm start
```

If something is already listening on the port, the app attaches to it instead of spawning its own server.

## How it works

1. Window opens instantly with a splash screen.
2. The app spawns `node apps/cli/lib/bin.js web` (or `tsx` source mode as fallback) as a child process.
3. It polls for a real HTTP 200 (a TCP connect is not enough — the webserver binds before the plugin/RPC tree is mounted).
4. The UI is loaded, and a health loop reloads the page if the SPA raced server readiness ("Failed to load plugins" / empty shell).

## Troubleshooting

- **Window shows "Failed to load plugins"** — the SPA raced the server; the health loop reloads automatically. If it persists, wait for the harness to finish booting and restart the app.
- **Port already in use** — the app attaches to the existing server; close the other `dsh web` if you want the app to own the lifecycle.
- **Blank/black window on Linux** — hardware acceleration is disabled by default; set `DSH_DESKTOP_DEBUG=1` and check `/tmp/dsh-window.png` to see what the renderer produced.

## License

MIT
