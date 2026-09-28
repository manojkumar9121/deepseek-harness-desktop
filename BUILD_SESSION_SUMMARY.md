# DeepSeek Harness Desktop - Build Session Summary

## Goal
Create a self-contained Windows `.exe` that bundles the DeepSeek Harness so non-technical users can just install and run without needing to clone/build the harness separately.

## What We Tried

### Approach 1: Bundle Full Harness (FAILED)
- Copied entire `~/deepseek-harness` to `dist/staging/harness/`
- Size: 1.7GB (too large, includes dev tools/tests)
- Issue: pnpm workspace symlinks are relative and break when copied

### Approach 2: Bundle Compiled Output Only (PARTIAL SUCCESS)
- Copied compiled packages: 53MB
- Copied node_modules: 1.5GB
- Total: ~1.7GB still too large
- Issue: Symlinks in `apps/cli/node_modules/@deepseek-ai/` point to `../../../../packages/...` which breaks when directory structure changes

### Approach 3: esbuild Bundling (WORKING - NEEDS FINALIZATION)
- Bundled CLI entry point: `apps/cli/lib/types/bin.js`
- Output: 19KB bundle (with external deps) or 370KB (full bundle)
- Issue: Bundle uses `import.meta.url` to resolve paths like `../package.json` and `../config/agent-presets/`

## Current Working State

### Bundle Created
```bash
cd ~/deepseek-harness && esbuild 'apps/cli/lib/types/bin.js' \
  --bundle \
  --platform=node \
  --format=esm \
  --outdir=/tmp/dsh-bundle/lib \
  --external:'@deepseek-ai/*' \
  --external:commander \
  --external:js-yaml \
  --external:node-addon-require-builtin \
  --external:ws \
  --external:zod \
  --external:react \
  --external:react-dom \
  --external:'*.node' \
  --external:node-pty \
  --external:koffi \
  --external:e2b
```

### Bundle Structure
```
/tmp/dsh-bundle/
├── package.json          # Copy from ~/deepseek-harness/apps/cli/package.json
├── config/               # Copy from ~/deepseek-harness/apps/cli/config
├── lib/
│   └── bin.js           # 19KB bundle
├── node_modules/        # Copy from ~/deepseek-harness/apps/cli/node_modules
├── packages/            # Copy from ~/deepseek-harness/packages (for symlinks)
└── vendor/              # Copy from ~/deepseek-harness/vendor (for symlinks)
```

### Symlink Problem
The bundle's node_modules has symlinks like:
```
node_modules/@deepseek-ai/dsh-app-boot -> ../../../../packages/boot/app-boot
```

These expect `packages/` at the root level. When we run from `/tmp/dsh-bundle/`, the symlinks resolve to `/packages/` which doesn't exist.

## Files Changed in This Repo

### `main.js`
- Updated `HARNESS_DIR` to use bundled path when packaged:
  ```js
  const HARNESS_DIR = process.env.DSH_HARNESS_DIR || 
    (app.isPackaged ? path.join(process.resourcesPath, 'harness') : 
     path.join(os.homedir(), 'deepseek-harness'))
  ```
- Updated to use Electron's Node binary in packaged mode:
  ```js
  const nodeBin = app.isPackaged ? process.execPath : 'node'
  const env = app.isPackaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined
  dshProcess = spawn(nodeBin, args, { cwd: HARNESS_DIR, stdio: ['ignore', 'pipe', 'pipe'], env })
  ```

### `electron-builder.yml`
- Added `extraResources` to bundle the harness:
  ```yaml
  extraResources:
    - from: dist/staging/harness
      to: harness
      filter:
        - "**/*"
  ```

## Next Steps for New Session

1. **Fix the symlink issue** - Either:
   - Copy packages/vendor to `/packages/` and `/vendor/` at root level
   - Or flatten the symlinks by copying actual package contents instead of symlinks

2. **Create a staging script** that:
   - Runs esbuild to create the bundle
   - Copies node_modules with resolved symlinks
   - Sets up the correct directory structure

3. **Update electron-builder.yml** to include the staged harness

4. **Test the bundle** runs correctly:
   ```bash
   node /tmp/dsh-bundle/lib/bin.js web --help
   ```

5. **Build the Windows installer** and verify it works

## Key Files
- `~/deepseek-harness/apps/cli/lib/types/bin.js` - CLI entry point
- `~/deepseek-harness/apps/cli/node_modules/@deepseek-ai/` - Workspace symlinks
- `~/deepseek-harness/packages/` - Compiled packages (53MB)
- `~/deepseek-harness/vendor/` - Vendored dependencies
- `/tmp/dsh-bundle/` - Current bundle location (19KB + deps)

## Size Target
- Bundle: ~20KB
- node_modules: ~100-300MB (runtime deps only)
- Node runtime: ~50-100MB
- **Target EXE: ~200-400MB** (vs current 1.7GB)
