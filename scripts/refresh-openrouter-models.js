'use strict'

// Refreshes the installed pi-ai OpenRouter model catalog at launch.
//
// The harness serves its OpenRouter model picker from a static snapshot
// (`@earendil-works/pi-ai/dist/providers/data/openrouter.json`) that is only
// regenerated when pi-ai releases a new version, so models OpenRouter adds
// mid-release stay invisible until the dependency is bumped. This script
// fetches OpenRouter's public model list and appends the ids the snapshot
// does not know yet, in exactly the entry shape pi-ai's own generator emits.
// Bundled entries always win: their capacities and compat quirks are curated,
// while appended entries carry conservative defaults.

const fs = require('node:fs')
const path = require('node:path')

const PI_AI_PACKAGE = '@earendil-works/pi-ai'
const OPENROUTER_CATALOG_RELATIVE = path.join('dist', 'providers', 'data', 'openrouter.json')
const NVIDIA_CATALOG_RELATIVE = path.join('dist', 'providers', 'data', 'nvidia.json')
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models'
const FETCH_TIMEOUT_MS = 10_000
const DEFAULT_CONTEXT_WINDOW = 65_536
const DEFAULT_MAX_TOKENS = 16_384
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** Read a simple `key: value` env file (skip blank lines and comments). */
function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const result = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx < 0) continue
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return result
}

/** Positive finite integer, or undefined. */
function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Numeric descending sort of `.pnpm` directory names like `@earendil-works+pi-ai@0.84.3_…`. */
function compareCatalogDirsDesc(a, b) {
  const versionOf = (entry) => entry.slice(entry.indexOf('@') + 1).split('_')[0]
    .split('.').map((part) => Number.parseInt(part, 10) || 0)
  const va = versionOf(a)
  const vb = versionOf(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0)
  }
  return b.localeCompare(a)
}

/**
 * Locate the installed catalog under one harness checkout. Prefers the pnpm
 * store layout, falling back to a plain nested `node_modules` install.
 * @param relative - catalog file path relative to the pi-ai package root.
 */
function catalogPath(harnessDir, relative = OPENROUTER_CATALOG_RELATIVE) {
  const store = path.join(harnessDir, 'node_modules', '.pnpm')
  if (fs.existsSync(store)) {
    const dirs = fs.readdirSync(store)
      .filter((entry) => entry.startsWith(`${PI_AI_PACKAGE.replace('/', '+')}@`))
      .sort(compareCatalogDirsDesc)
    for (const dir of dirs) {
      const candidate = path.join(store, dir, 'node_modules', ...PI_AI_PACKAGE.split('/'), relative)
      if (fs.existsSync(candidate)) return candidate
    }
    return undefined
  }
  const plain = path.join(harnessDir, 'node_modules', ...PI_AI_PACKAGE.split('/'), relative)
  return fs.existsSync(plain) ? plain : undefined
}

/**
 * Parse OpenRouter pricing string into a non-negative number, or undefined if
 * the price is unknown (-1) or missing. pi-ai treats any cost > 0 as paid; 0
 * means free.
 */
function parsePrice(value) {
  if (typeof value !== 'string') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** One live OpenRouter model as a pi-ai catalog entry, matching the shipped shape. */
function toPiAiEntry(live) {
  const contextWindow = positiveInt(live.context_length) ?? DEFAULT_CONTEXT_WINDOW
  const modalities = Array.isArray(live.architecture?.input_modalities)
    ? live.architecture.input_modalities.filter((modality) => modality === 'text' || modality === 'image')
    : []
  const reasoning = Array.isArray(live.supported_parameters) && live.supported_parameters.includes('reasoning')
  const pricing = live.pricing ?? {}
  return {
    id: live.id,
    name: typeof live.name === 'string' && live.name.length > 0 ? live.name : live.id,
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    provider: 'openrouter',
    reasoning,
    // Reasoning models need off pinned to null: pi-ai's openrouter dispatch
    // otherwise answers a no-effort request with reasoning effort "none",
    // which reasoning-mandatory endpoints reject (HTTP 400).
    ...(reasoning ? { thinkingLevelMap: { off: null } } : {}),
    input: modalities.length > 0 ? modalities : ['text'],
    cost: {
      input: parsePrice(pricing.prompt) ?? 0,
      output: parsePrice(pricing.completion) ?? 0,
      cacheRead: parsePrice(pricing.input_cache_read) ?? 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens: positiveInt(live.top_provider?.max_completion_tokens) ?? DEFAULT_MAX_TOKENS,
    // The shipped snapshot's majority variant; `thinkingFormat` is constant
    // across every bundled openrouter entry, and declining the developer role
    // is the conservative default for an unknown endpoint.
    compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter' },
  }
}

/**
 * Refresh the pricing and capacity fields of an already-cached catalog entry
 * against live OpenRouter data. Returns true when the entry was updated.
 * Curated compat quirks are preserved — only mutable runtime fields are
 * refreshed.
 */
function refreshExistingEntry(existing, live) {
  const pricing = live.pricing ?? {}
  const input = Array.isArray(live.architecture?.input_modalities)
    ? live.architecture.input_modalities.filter((modality) => modality === 'text' || modality === 'image')
    : []
  const reasoning = Array.isArray(live.supported_parameters) && live.supported_parameters.includes('reasoning')
  const name = typeof live.name === 'string' && live.name.length > 0 ? live.name : existing.name
  const contextWindow = positiveInt(live.context_length) ?? existing.contextWindow
  const maxTokens = positiveInt(live.top_provider?.max_completion_tokens) ?? existing.maxTokens
  const needsUpdate =
    existing.cost.input !== (parsePrice(pricing.prompt) ?? 0) ||
    existing.cost.output !== (parsePrice(pricing.completion) ?? 0) ||
    existing.cost.cacheRead !== (parsePrice(pricing.input_cache_read) ?? 0) ||
    existing.contextWindow !== contextWindow ||
    existing.maxTokens !== maxTokens ||
    existing.reasoning !== reasoning ||
    JSON.stringify(existing.input) !== JSON.stringify(input.length > 0 ? input : ['text']) ||
    existing.name !== name
  if (!needsUpdate) return false
  existing.name = name
  existing.reasoning = reasoning
  if (reasoning) {
    existing.thinkingLevelMap = { off: null }
  } else {
    delete existing.thinkingLevelMap
  }
  existing.input = input.length > 0 ? input : ['text']
  existing.cost = {
    input: parsePrice(pricing.prompt) ?? 0,
    output: parsePrice(pricing.completion) ?? 0,
    cacheRead: parsePrice(pricing.input_cache_read) ?? 0,
    cacheWrite: 0,
  }
  existing.contextWindow = contextWindow
  existing.maxTokens = maxTokens
  return true
}

/** One live NVIDIA model as a pi-ai catalog entry. All NVIDIA models are free. */
function toNvidiaEntry(live) {
  const reasoning = live.owned_by === 'deepseek-ai' ||
    live.id.startsWith('nvidia/') ||
    live.id.startsWith('meta/') ||
    live.id.startsWith('moonshotai/') ||
    live.id.startsWith('openai/') ||
    live.id.startsWith('poolside/') ||
    live.id.startsWith('stepfun-ai/') ||
    live.id.startsWith('thinkingmachines/') ||
    live.id.startsWith('z-ai/') ||
    live.id.startsWith('minimaxai/')
  return {
    id: live.id,
    name: live.id.split('/').slice(1).join(' '),
    api: 'openai-completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    provider: 'nvidia',
    headers: { 'NVCF-POLL-SECONDS': '3600' },
    reasoning,
    ...(reasoning ? {
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    } : {}),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
      ...(reasoning ? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek' } : {}),
    },
  }
}

/**
 * Refresh the NVIDIA catalog: add new models, remove stale ones.
 * NVIDIA provides no pricing — every model is free.
 * @param harnessDir - the harness checkout whose pi-ai install gets patched.
 * @param log - progress sink.
 * @param nvidiaApiKey - NVAPI bearer token.
 * @returns how many models were changed.
 */
async function refreshNvidiaCatalog(harnessDir, log = () => {}, nvidiaApiKey = '') {
  const file = catalogPath(harnessDir, NVIDIA_CATALOG_RELATIVE)
  if (file === undefined) throw new Error(`no installed ${PI_AI_PACKAGE} nvidia catalog found under ${harnessDir}`)
  if (!nvidiaApiKey) throw new Error('nvidia api key is required to refresh the nvidia catalog')

  const response = await fetch(NVIDIA_MODELS_URL, {
    headers: { authorization: `Bearer ${nvidiaApiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`nvidia responded ${response.status}`)
  const payload = await response.json()
  const live = Array.isArray(payload?.data) ? payload.data : []
  if (live.length === 0) throw new Error('nvidia listed no models')

  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'))
  const served = catalog['openai-completions'] ?? (catalog['openai-completions'] = {})
  const liveIds = new Set(live.map((m) => m.id))
  const added = []
  const removed = []
  for (const id of Object.keys(served)) {
    if (!liveIds.has(id)) {
      delete served[id]
      removed.push(id)
    }
  }
  for (const entry of live) {
    if (typeof entry?.id !== 'string' || entry.id.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(served, entry.id)) continue
    served[entry.id] = toNvidiaEntry(entry)
    added.push(entry.id)
  }

  const total = added.length + removed.length
  if (total === 0) {
    log('[dsh-desktop] nvidia catalog already current')
    return 0
  }

  const staged = path.join(path.dirname(file), `.nvidia.json.${process.pid}.tmp`)
  fs.writeFileSync(staged, JSON.stringify(catalog))
  fs.renameSync(staged, file)

  const sample = [...added, ...removed].slice(0, 3).join(', ')
  const parts = []
  if (added.length > 0) parts.push(`+${added.length} new`)
  if (removed.length > 0) parts.push(`-${removed.length} removed`)
  log(`[dsh-desktop] nvidia catalog: ${parts.join(', ')}` +
    (sample.length > 0 ? ` (${sample}${total > 3 ? ', …' : ''})` : ''))
  return total
}

/**
 * Append models OpenRouter knows but the installed snapshot lacks.
 * @param harnessDir - the harness checkout whose pi-ai install gets patched.
 * @param log - progress sink.
 * @returns how many models were added (0 when the snapshot was already current).
 */
async function refreshOpenRouterCatalog(harnessDir, log = () => {}) {
  const file = catalogPath(harnessDir)
  if (file === undefined) throw new Error(`no installed ${PI_AI_PACKAGE} openrouter catalog found under ${harnessDir}`)

  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`openrouter responded ${response.status}`)
  const payload = await response.json()
  const live = Array.isArray(payload?.data) ? payload.data : []
  if (live.length === 0) throw new Error('openrouter listed no models')

  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'))
  const served = catalog['openai-completions'] ?? (catalog['openai-completions'] = {})
  const added = []
  const updated = []
  for (const entry of live) {
    if (typeof entry?.id !== 'string' || entry.id.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(served, entry.id)) {
      if (refreshExistingEntry(served[entry.id], entry)) updated.push(entry.id)
      continue
    }
    served[entry.id] = toPiAiEntry(entry)
    added.push(entry.id)
  }

  const total = added.length + updated.length
  if (total === 0) {
    log('[dsh-desktop] openrouter catalog already current')
    return 0
  }

  // Write-temp-then-rename inside the same directory: the swap is atomic, and
  // replacing the directory entry breaks pnpm's hardlink into its
  // content-addressable store, so only THIS checkout sees the appended models.
  const staged = path.join(path.dirname(file), `.openrouter.json.${process.pid}.tmp`)
  fs.writeFileSync(staged, JSON.stringify(catalog))
  fs.renameSync(staged, file)

  const sample = [...added, ...updated].slice(0, 3).join(', ')
  const parts = []
  if (added.length > 0) parts.push(`+${added.length} new`)
  if (updated.length > 0) parts.push(`~${updated.length} updated`)
  log(`[dsh-desktop] openrouter catalog: ${parts.join(', ')}` +
    (sample.length > 0 ? ` (${sample}${total > 3 ? ', …' : ''})` : ''))
  return total
}

module.exports = { refreshOpenRouterCatalog, refreshNvidiaCatalog, readEnvFile }

if (require.main === module) {
  ;(async () => {
    const target = process.argv[2] ?? process.env.DSH_HARNESS_DIR
      ?? path.join(require('node:os').homedir(), 'deepseek-harness')
    const envFile = process.argv[3] ?? process.env.DSH_API_KEYS_DIR
      ? path.join(process.env.DSH_API_KEYS_DIR, 'nvidia.env')
      : path.join(require('node:os').homedir(), 'Documents', 'api keys', 'nvidia.env')
    const env = readEnvFile(envFile)
    const nvidiaKey = env.nvidia ?? ''
    const [orCount, nvCount] = await Promise.all([
      refreshOpenRouterCatalog(target, (message) => console.log(message)),
      nvidiaKey
        ? refreshNvidiaCatalog(target, (message) => console.log(message), nvidiaKey).catch((e) => {
            console.warn('[dsh-desktop] nvidia catalog refresh skipped:', e.message)
            return 0
          })
        : Promise.resolve(0),
    ])
    process.exitCode = 0
  })()
}
