#!/usr/bin/env node
/**
 * Stage the DeepSeek Harness for bundling into the Electron app.
 *
 * Usage:
 *   node scripts/stage-harness.js [--source /path/to/deepseek-harness] [--output /path/to/staging]
 */

const { execFileSync } = require('node:child_process');
const { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

const DEFAULT_SOURCE = process.env.DSH_HARNESS_DIR || join(process.env.HOME || '', 'deepseek-harness');
const DEFAULT_OUTPUT = join(__dirname, '..', 'dist', 'staging');

const args = process.argv.slice(2);
let sourceDir = DEFAULT_SOURCE;
let outputDir = DEFAULT_OUTPUT;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source' && args[i + 1]) sourceDir = args[++i];
  else if (args[i] === '--output' && args[i + 1]) outputDir = args[++i];
}

sourceDir = resolve(sourceDir);
outputDir = resolve(outputDir);

function contains(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === '' || (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

if (contains(sourceDir, outputDir) || contains(outputDir, sourceDir)) {
  throw new Error('[stage] source and output directories must not overlap');
}

console.log(`[stage] source: ${sourceDir}`);
console.log(`[stage] output: ${outputDir}`);

const sourceManifest = join(sourceDir, 'apps', 'cli', 'package.json');
const sourceBin = join(sourceDir, 'apps', 'cli', 'lib', 'bin.js');
if (!existsSync(join(sourceDir, 'packages')) || !existsSync(sourceManifest)) {
  console.error('[stage] ERROR: source directory does not look like a DeepSeek Harness checkout');
  process.exit(1);
}
if (!existsSync(sourceBin)) {
  console.error('[stage] ERROR: Harness CLI is not built; run pnpm run build in the source checkout');
  process.exit(1);
}

const sourcePackage = JSON.parse(readFileSync(sourceManifest, 'utf8'));
if (typeof sourcePackage.version !== 'string' || sourcePackage.version.length === 0) {
  throw new Error('[stage] source CLI manifest has no version');
}

if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

console.log(`[stage] installing @deepseek-ai/dsh@${sourcePackage.version} production runtime...`);
const npmArgs = [
  'install',
  '--prefix',
  outputDir,
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  `@deepseek-ai/dsh@${sourcePackage.version}`,
];
if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
  execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { stdio: 'inherit' });
} else if (process.platform === 'win32') {
  throw new Error('[stage] run this script through npm on Windows so npm_execpath is available');
} else {
  execFileSync('npm', npmArgs, { stdio: 'inherit' });
}

const runtimeRoot = join(outputDir, 'node_modules');
const builtBin = join(runtimeRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const requiredFiles = [
  builtBin,
  join(runtimeRoot, '@deepseek-ai', 'dsh', 'package.json'),
  join(runtimeRoot, '@deepseek-ai', 'dsh-web-app', 'package.json'),
  join(runtimeRoot, '@deepseek-ai', 'dsh-web-frontend', 'package.json'),
  join(runtimeRoot, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
  join(runtimeRoot, '@deepseek-ai', 'node-addon-system', 'package.json'),
];

const nativeTarget = {
  linux: { x64: 'linux-x64', arm64: 'linux-arm64' },
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
}[process.platform]?.[process.arch];
if (nativeTarget !== undefined) {
  const nativeRoot = join(runtimeRoot, '@deepseek-ai', `node-addon-system-${nativeTarget}`);
  requiredFiles.push(join(nativeRoot, 'package.json'));
  if (process.platform === 'linux') {
    requiredFiles.push(join(nativeRoot, 'bin', 'landlock-run'));
    requiredFiles.push(join(nativeRoot, 'bin', 'glibc', 'system.node'));
    requiredFiles.push(join(nativeRoot, 'bin', 'musl', 'system.node'));
    const requireBuiltinPackage = `node-addon-require-builtin-linux-${process.arch}-gnu`;
    requiredFiles.push(join(runtimeRoot, requireBuiltinPackage, 'package.json'));
    requiredFiles.push(join(runtimeRoot, requireBuiltinPackage, 'prebuilt', `linux-${process.arch}-gnu-napi-v9.node`));
  }
}

for (const file of requiredFiles) {
  if (!existsSync(file)) throw new Error(`[stage] staged runtime is missing ${file}`);
}

execFileSync(process.execPath, [builtBin, '--version'], { cwd: outputDir, stdio: 'inherit' });

const totalSize = (function walkSize(directory) {
  let size = 0;
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) size += walkSize(file);
    else size += stat.size;
  }
  return size;
})(outputDir);

console.log(`\n[stage] done! Staged harness size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`[stage] output: ${outputDir}`);
