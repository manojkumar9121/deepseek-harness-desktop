# DeepSeek Harness Desktop

Electron desktop wrapper for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`).

Turns the harness's local web UI into a native window: instant splash screen while the harness server boots, then the full harness interface — sessions, workspace, model picker, MCP servers.

## Why

- No browser tab; the harness is managed as a child process by the app (it is spawned and killed with the app).
- Fixes a startup race where loading the SPA before the harness plugin tree is ready leaves a blank/black window.
- Handles fractional scaling and small screens (window is sized to fit the work area).

## Prerequisites

- **Node.js 22.19+ or 24+** (required by Electron Builder and DeepSeek Harness)
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
| `DSH_UI_URL`         | unset                | Full authenticated launch URL for an existing Harness process |
| `DSH_DESKTOP_DEBUG`  | off                  | `1` dumps DOM + screenshot to `/tmp`     |
| `DSH_REFRESH_MODELS` | off                  | `1` enables launch-time OpenRouter/NVIDIA catalog refreshes |

Example:

```bash
DSH_HARNESS_DIR=/opt/deepseek-harness DSH_PORT=4000 npm start
```

To attach to an existing Harness process, pass its full tokenized startup URL through `DSH_UI_URL`. The app never loads an unauthenticated local service.

## How it works

1. Window opens instantly with a splash screen.
2. Model catalog refreshes are opt-in in development with `DSH_REFRESH_MODELS=1`; packaged builds never modify their immutable runtime.
3. In development, the app spawns the built checkout CLI (or `tsx` source mode as fallback). Packaged builds run the exact-version production CLI staged under `resources/harness/node_modules`.
4. It captures the tokenized launch URL printed by `dsh web` and waits for its authenticated HTTP response before loading the UI.
5. The UI is loaded, and a health loop reloads the page if the SPA raced server readiness ("Failed to load plugins" / empty shell).

## Packaging

Packaging commands stage the matching published Harness runtime automatically:

```bash
npm run package:linux
```

The staged runtime includes the CLI, Web frontend, production dependencies, and Linux native modules.

## Troubleshooting

- **Window shows "Failed to load plugins"** — the SPA raced the server; the health loop reloads automatically. If it persists, wait for the harness to finish booting and restart the app.
- **Port already in use** — current Harness releases require the tokenized URL printed at startup. Set `DSH_UI_URL` to that full URL when attaching to an existing server, or close the other `dsh web` process.
- **Blank/black window on Linux** — hardware acceleration is disabled by default; set `DSH_DESKTOP_DEBUG=1` and check `/tmp/dsh-window.png` to see what the renderer produced.

## License

MIT
