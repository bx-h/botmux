import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildLarkCliProfileWrapperContent, buildLarkCliProfileWrapperNodeScript } from '../src/utils/lark-cli-profile-wrapper.js';

function makeFixture() {
  const root = mkdtempSync(join(process.cwd(), '.tmp-botmux-lark-cli-wrapper-'));
  const home = join(root, 'home');
  const wrapperDir = join(root, 'wrapper-bin');
  const realDir = join(root, 'real-bin');
  mkdirSync(join(home, '.lark-cli'), { recursive: true });
  mkdirSync(wrapperDir, { recursive: true });
  mkdirSync(realDir, { recursive: true });
  const wrapper = join(wrapperDir, 'lark-cli');
  const out = join(root, 'args.txt');
  writeFileSync(
    join(realDir, 'lark-cli'),
    '#!/bin/sh\n: > "$BOTMUX_FAKE_OUT"\nfor arg in "$@"; do printf "%s\\n" "$arg" >> "$BOTMUX_FAKE_OUT"; done\n',
    { mode: 0o755 },
  );
  chmodSync(join(realDir, 'lark-cli'), 0o755);
  writeFileSync(wrapper, buildLarkCliProfileWrapperContent({ nodePath: process.execPath, wrapperPath: wrapper }), { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  return { root, home, wrapper, wrapperDir, realDir, out };
}

function readArgs(path: string): string[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
}

describe('lark-cli profile wrapper', () => {
  it('injects the BOTMUX_LARK_APP_ID profile when a matching lark-cli profile exists', () => {
    const f = makeFixture();
    try {
      writeFileSync(join(f.home, '.lark-cli', 'config.json'), JSON.stringify({ apps: [{ name: 'cli_doc', appId: 'cli_doc' }] }));
      const res = spawnSync(f.wrapper, ['config', 'show'], {
        env: { HOME: f.home, PATH: `${f.wrapperDir}:${f.realDir}`, BOTMUX_LARK_APP_ID: 'cli_doc', BOTMUX_FAKE_OUT: f.out },
      });
      expect(res.status).toBe(0);
      expect(readArgs(f.out)).toEqual(['--profile', 'cli_doc', 'config', 'show']);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('does not override an explicit --profile argument', () => {
    const f = makeFixture();
    try {
      writeFileSync(join(f.home, '.lark-cli', 'config.json'), JSON.stringify({ apps: [{ name: 'cli_doc', appId: 'cli_doc' }] }));
      const res = spawnSync(f.wrapper, ['--profile', 'manual', 'config', 'show'], {
        env: { HOME: f.home, PATH: `${f.wrapperDir}:${f.realDir}`, BOTMUX_LARK_APP_ID: 'cli_doc', BOTMUX_FAKE_OUT: f.out },
      });
      expect(res.status).toBe(0);
      expect(readArgs(f.out)).toEqual(['--profile', 'manual', 'config', 'show']);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('does not rely on PATH tools and excludes the wrapper itself by realpath', () => {
    const script = buildLarkCliProfileWrapperNodeScript();
    expect(script).not.toContain('dirname');
    expect(script).not.toContain('grep');
    expect(script).toContain('candidateRealPath === wrapperRealPath');
    expect(script).toContain('process.exit(127)');
  });
});
