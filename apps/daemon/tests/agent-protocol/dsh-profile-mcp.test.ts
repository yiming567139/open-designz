import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDshProfileMcpServers } from '../../src/agent-protocol/dsh-profile/mcp.js';
import type { DshProfileMcpServerWire } from '../../src/agent-protocol/dsh-profile/types.js';
import type { McpServerConfig } from '../../src/mcp-config.js';

function stdioServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'local-tools',
    transport: 'stdio',
    enabled: true,
    command: 'node',
    args: ['server.js'],
    env: { API_TOKEN: 'secret' },
    ...overrides,
  };
}

function remoteServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'remote-tools',
    transport: 'http',
    enabled: true,
    url: 'https://example.test/mcp',
    ...overrides,
  };
}

describe('buildDshProfileMcpServers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('projects a stdio server onto the wire without daemon-only fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = buildDshProfileMcpServers([
      stdioServer({ label: 'Local tools', authMode: 'none' }),
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(wire).toEqual([
      {
        id: 'local-tools',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { API_TOKEN: 'secret' },
      } satisfies DshProfileMcpServerWire,
    ]);
  });

  it('drops a stdio server without a command instead of failing the frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { command: _dropped, ...withoutCommand } = stdioServer();
    const wire = buildDshProfileMcpServers([
      { ...withoutCommand, id: 'broken' },
    ]);
    expect(wire).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropping MCP server "broken"'),
    );
  });

  it('injects the stored OAuth bearer for a token-bound http server', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = buildDshProfileMcpServers(
      [remoteServer({ authMode: 'oauth' })],
      { 'remote-tools': 'tok-123' },
    );
    expect(wire).toEqual([
      {
        id: 'remote-tools',
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer tok-123' },
      },
    ]);
  });

  it('lets a user-pinned Authorization header win and drops blank ones', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pinned = buildDshProfileMcpServers(
      [remoteServer({ authMode: 'oauth', headers: { Authorization: 'Bearer mine' } })],
      { 'remote-tools': 'tok-123' },
    );
    expect(pinned[0]?.headers).toEqual({ Authorization: 'Bearer mine' });

    const blank = buildDshProfileMcpServers(
      [remoteServer({ authMode: 'oauth', headers: { Authorization: '   ' } })],
      { 'remote-tools': 'tok-123' },
    );
    expect(blank[0]?.headers).toEqual({ Authorization: 'Bearer tok-123' });
  });

  it('does not attach an Authorization header without an oauth token', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = buildDshProfileMcpServers(
      [remoteServer({ authMode: 'oauth' })],
      {},
    );
    expect(wire[0]).not.toHaveProperty('headers');
  });

  it('folds a legacy sse server onto streamable-http with auth injection', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = buildDshProfileMcpServers(
      [
        remoteServer({
          id: 'legacy-sse',
          transport: 'sse',
          authMode: 'oauth',
        }),
      ],
      { 'legacy-sse': 'tok-sse' },
    );
    expect(wire).toEqual([
      {
        id: 'legacy-sse',
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer tok-sse' },
      },
    ]);
  });

  it('lowercases and truncates server ids to the dsh-mcp-client name limit', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = buildDshProfileMcpServers([
      stdioServer({ id: 'Very-Long_Server.Id_0123456789_abcd' }),
    ]);
    expect(wire[0]?.id).toBe('very-long_server.id_0123456789_a');
    expect(wire[0]?.id).toHaveLength(32);
  });

  it('suffixes truncation collisions so both servers mount', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = buildDshProfileMcpServers([
      stdioServer({ id: 'a-very-long-server-name-0123456789-alpha' }),
      stdioServer({ id: 'a-very-long-server-name-0123456789-beta' }),
    ]);
    expect(wire.map((entry) => entry.id)).toEqual([
      'a-very-long-server-name-01234567',
      'a-very-long-server-name-012345-2',
    ]);
  });

  it('caps the frame list at 32 servers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const servers = Array.from({ length: 40 }, (_, index) =>
      stdioServer({ id: `srv-${index}` }),
    );
    const wire = buildDshProfileMcpServers(servers);
    expect(wire).toHaveLength(32);
    expect(wire.at(-1)?.id).toBe('srv-31');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('32-server frame limit'));
  });
});
