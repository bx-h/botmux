function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildLarkCliProfileWrapperContent(options: { nodePath: string; wrapperPath: string }): string {
  const nodePath = shellSingleQuote(options.nodePath);
  const wrapperPath = shellSingleQuote(options.wrapperPath);
  return `#!/bin/sh
set -eu

BOTMUX_LARK_CLI_WRAPPER=${wrapperPath} exec ${nodePath} - "$@" <<'BOTMUX_LARK_CLI_NODE'
${buildLarkCliProfileWrapperNodeScript()}
BOTMUX_LARK_CLI_NODE
`;
}

export function buildLarkCliProfileWrapperNodeScript(): string {
  return `const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);

function realPathMaybe(file) {
  try { return fs.realpathSync(file); }
  catch { return ''; }
}

const wrapperRealPath = realPathMaybe(process.env.BOTMUX_LARK_CLI_WRAPPER || '');
let realCli = '';
for (const entry of (process.env.PATH || '').split(path.delimiter)) {
  const dir = entry || '.';
  const candidate = path.resolve(dir, 'lark-cli');
  const candidateRealPath = realPathMaybe(candidate);
  if (!candidateRealPath) continue;
  if (wrapperRealPath && candidateRealPath === wrapperRealPath) continue;
  try { fs.accessSync(candidate, fs.constants.X_OK); }
  catch { continue; }
  realCli = candidate;
  break;
}

if (!realCli) {
  console.error('botmux lark-cli wrapper: real lark-cli not found in PATH');
  process.exit(127);
}

const hasProfileArg = args.some(arg => arg === '--profile' || arg.startsWith('--profile='));
const profile = process.env.BOTMUX_LARK_APP_ID || '';
if (!hasProfileArg && profile && hasProfile(profile)) {
  args.unshift(profile);
  args.unshift('--profile');
}

const child = cp.spawnSync(realCli, args, { stdio: 'inherit', env: process.env });
if (child.error) {
  console.error('botmux lark-cli wrapper: failed to execute real lark-cli: ' + child.error.message);
  process.exit(child.error.code === 'ENOENT' ? 127 : 1);
}
if (child.signal) process.exit(128);
process.exit(child.status == null ? 1 : child.status);

function hasProfile(profile) {
  const home = process.env.HOME || os.homedir();
  if (!home) return false;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, '.lark-cli', 'config.json'), 'utf8'));
    const apps = Array.isArray(config && config.apps) ? config.apps : [];
    return apps.some(app => app && (app.name === profile || app.appId === profile));
  } catch {
    return false;
  }
}
`;
}
