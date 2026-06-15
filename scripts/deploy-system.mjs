#!/usr/bin/env node
// Build this checkout, point the runtime wrapper at its dist/cli.js, then
// restart the local PM2-managed botmux daemon. This is intentionally explicit:
// CI/test builds should not silently claim or restart the dogfood runtime.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(repoRoot, 'dist');
const cliPath = join(distDir, 'cli.js');
const daemonPath = join(distDir, 'index-daemon.js');
const wrapperPath = join(homedir(), '.botmux', 'bin', 'botmux');

const args = new Set(process.argv.slice(2).filter(arg => arg !== '--'));
const skipBuild = args.has('--no-build');
const skipRestart = args.has('--no-restart');
const includePm2 = args.has('--include-pm2');
const skipSoulScan = args.has('--no-soul-scan');

function run(label, command, commandArgs, options = {}) {
  console.log(`\n==> ${label}`);
  console.log(`$ ${[command, ...commandArgs].join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      COREPACK_DEFAULT_TO_LATEST: process.env.COREPACK_DEFAULT_TO_LATEST ?? '0',
    },
    ...options,
  });
  if (result.error) {
    console.error(`\n✗ ${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${label} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    console.error(`\n✗ Missing ${label}: ${path}`);
    process.exit(1);
  }
}

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walkFiles(path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

function assertNoSoulRuntimeResidue() {
  if (!existsSync(distDir)) return;
  const needles = ['soulPath', 'soulRoot', 'bot_persona', 'buildSoulPromptBlock'];
  const hits = [];
  for (const file of walkFiles(distDir)) {
    if (!/\.(?:js|mjs|cjs|d\.ts|map)$/.test(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const needle of needles) {
      if (text.includes(needle)) hits.push(`${relative(repoRoot, file)}:${needle}`);
    }
  }
  if (hits.length > 0) {
    console.error('\n✗ dist still contains removed SOUL runtime symbols:');
    for (const hit of hits.slice(0, 40)) console.error(`  - ${hit}`);
    if (hits.length > 40) console.error(`  ... ${hits.length - 40} more`);
    console.error('Run a clean build or inspect the stale dist output before restarting.');
    process.exit(1);
  }
  console.log('✓ dist has no SOUL runtime residue');
}

function assertWrapperPointsHere() {
  assertExists(wrapperPath, 'botmux wrapper');
  const wrapper = readFileSync(wrapperPath, 'utf8');
  if (!wrapper.includes(cliPath)) {
    console.error(`\n✗ ${wrapperPath} does not point at this checkout:`);
    console.error(wrapper.trim());
    process.exit(1);
  }
  console.log(`✓ runtime wrapper points at ${cliPath}`);
}

console.log(`botmux system deploy from ${repoRoot}`);
console.log(`options: build=${!skipBuild}, restart=${!skipRestart}, includePm2=${includePm2}`);

if (!skipBuild) {
  run('build dist', 'corepack', ['pnpm', 'build']);
}

assertExists(cliPath, 'dist cli');
assertExists(daemonPath, 'dist daemon');

if (!skipSoulScan) {
  assertNoSoulRuntimeResidue();
}

run('claim ~/.botmux/bin/botmux for this checkout', process.execPath, [join(repoRoot, 'scripts', 'claim-botmux-bin.mjs')]);
assertWrapperPointsHere();

if (!skipRestart) {
  const restartArgs = [cliPath, 'restart'];
  if (includePm2) restartArgs.push('--include-pm2');
  run('restart botmux daemon', process.execPath, restartArgs);
}

run('show botmux PM2 status', process.execPath, [cliPath, 'status']);

console.log('\n✓ botmux system deploy completed');
