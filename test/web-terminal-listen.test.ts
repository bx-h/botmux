/**
 * Regression: a busy preferredPort must NOT crash the worker.
 *
 * `new WebSocketServer({ server })` makes the ws library proxy the HTTP server's
 * 'error' event onto the WSS instance (ws ≥8). With no 'error' listener on the
 * WSS, an EADDRINUSE emits an UNHANDLED 'error' on the WSS and tears down the
 * whole worker process — BEFORE the HTTP server's own random-port fallback can
 * run, making that recovery dead code. listenWebTerminalWithFallback attaches a
 * WSS 'error' listener so the fallback actually fires. These tests exercise the
 * real helper against a genuinely-occupied port.
 *
 * Run: pnpm vitest run test/web-terminal-listen.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { listenWebTerminalWithFallback } from '../src/utils/web-terminal-listen.js';

const open: Server[] = [];
const wsServers: WebSocketServer[] = [];

function makePair(): { httpServer: Server; wss: WebSocketServer } {
  const httpServer = createServer((_req, res) => res.end('ok'));
  // Mirror worker.ts: ws proxies httpServer 'error' onto the wss at construction.
  const wss = new WebSocketServer({ server: httpServer });
  open.push(httpServer);
  wsServers.push(wss);
  return { httpServer, wss };
}

function listen(server: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

afterEach(async () => {
  for (const wss of wsServers.splice(0)) await new Promise<void>(r => wss.close(() => r()));
  for (const s of open.splice(0)) await new Promise<void>(r => s.close(() => r()));
});

describe('listenWebTerminalWithFallback', () => {
  it('binds the preferred port when it is free', async () => {
    const { httpServer, wss } = makePair();
    const port = await listenWebTerminalWithFallback({ httpServer, wss, host: '127.0.0.1', preferredPort: 0 });
    expect(port).toBeGreaterThan(0);
  });

  it('falls back to a random port without crashing when preferredPort is busy', async () => {
    // Occupy a port, then point a fresh server at it as its preferredPort.
    const blocker = makePair();
    const busyPort = await listen(blocker.httpServer, 0);

    const { httpServer, wss } = makePair();
    let crashed: unknown = null;
    // Deliberately do NOT attach our own wss 'error' listener here: the helper's
    // listener must be the only thing preventing ws's error proxy from turning
    // EADDRINUSE into an unhandled 'error' that tears down the process. If the
    // fix regresses, this test crashes instead of asserting — which still fails.
    const boundPort = await listenWebTerminalWithFallback({
      httpServer,
      wss,
      host: '127.0.0.1',
      preferredPort: busyPort,
    }).catch((e) => { crashed = e; return -1; });

    expect(crashed).toBeNull();
    expect(boundPort).toBeGreaterThan(0);
    expect(boundPort).not.toBe(busyPort);
  });

  it('rejects (does not fall back) for non-EADDRINUSE errors', async () => {
    const { httpServer, wss } = makePair();
    // No preferredPort → an invalid host triggers a non-EADDRINUSE error which
    // must reject rather than silently retry.
    await expect(
      listenWebTerminalWithFallback({ httpServer, wss, host: '203.0.113.1', preferredPort: undefined }),
    ).rejects.toBeTruthy();
  });
});
