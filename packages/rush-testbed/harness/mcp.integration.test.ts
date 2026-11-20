import { spawn } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectOk, fixtureRoot, rush, testbedRoot } from './lib.js';

const mcpBin = path.join(
  fixtureRoot,
  'common',
  'autoinstallers',
  'rush-plugins',
  'node_modules',
  '.bin',
  'fallow-rush',
);

interface JsonRpcMessage {
  id?: number;
  result?: {
    serverInfo?: { name: string; version: string };
    capabilities?: Record<string, unknown>;
    tools?: Array<{ name: string }>;
  };
}

/**
 * The Mimir-style simulated agent, minimal: a scripted stdio client that
 * performs the MCP initialize handshake and lists tools. This is the §6
 * acceptance for `rush fallow mcp` (spelled `fallow-rush mcp`; see
 * HERMES-WIRING.md for why agent configs exec the bin, not `rush fallow-mcp`).
 */
function mcpHandshake(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ serverInfo?: { name: string; version: string }; tools: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    let buffer = '';
    let initialized = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP handshake timed out; stdout so far: ${buffer.slice(0, 400)}`));
    }, timeoutMs);

    let serverInfo: { name: string; version: string } | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`non-JSON on MCP stdout (framing broken): ${line.slice(0, 200)}`));
          return;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          serverInfo = message.result?.serverInfo;
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ serverInfo, tools: (message.result?.tools ?? []).map((t) => t.name) });
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'rush-testbed', version: '0.0.0' },
        },
      })}\n`,
    );
  });
}

beforeAll(() => {
  expectOk(rush(['update-autoinstaller', '--name', 'rush-plugins']), 'rush update-autoinstaller');
}, 600_000);

describe('fallow-rush mcp (exec passthrough to fallow-mcp)', () => {
  it('answers the initialize handshake and lists tools over clean stdio', async () => {
    const { serverInfo, tools } = await mcpHandshake(mcpBin, ['mcp'], fixtureRoot);
    expect(serverInfo?.name).toBe('fallow-mcp');
    expect(serverInfo?.version).toBe('3.6.0');
    expect(tools).toContain('analyze');
    expect(tools).toContain('trace_export');
    expect(tools).toContain('trace_dependency');
    expect(tools.length).toBeGreaterThanOrEqual(20);
  }, 60_000);
});

describe('@rushstack/mcp-server against the fixture workspace', () => {
  // Regression guard for the fixture ESM landmine: rush-sdk loads rush-lib
  // through fixture/common/scripts/install-run-rush.js (CommonJS), which
  // crashes as ESM without the {"type":"commonjs"} scope marker — the exact
  // path @rushstack/mcp-server takes at startup.
  const rushMcpBin = path.join(testbedRoot, 'node_modules', '.bin', 'mcp-server');

  it('starts, answers the handshake, and lists the rush tools', async () => {
    const { serverInfo, tools } = await mcpHandshake(
      rushMcpBin,
      [fixtureRoot],
      fixtureRoot,
      90_000,
    );
    expect(serverInfo?.name).toBe('rush');
    expect(tools).toContain('rush_workspace_details');
    expect(tools).toContain('rush_project_details');
    expect(tools).toContain('rush_command_validator');
  }, 120_000);
});
