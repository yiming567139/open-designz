/** @module agent-protocol/dsh-profile/mcp
 * Projection of the daemon's external MCP servers onto the generation-1
 * `execute` frame's `mcp_servers` entries. The open-design profile plugin
 * parses each entry strictly and mounts it for the run through
 * @deepseek-ai/dsh-mcp-client, so this module owns the daemon side of that
 * projection: transport folding (`sse` → `http`), OAuth bearer injection,
 * server-name fitting, and per-entry failure isolation.
 */
import {
  effectiveMcpAuthMode,
  mergeAuthHeader,
} from '../../mcp-config.js';
import type { McpServerConfig } from '../../mcp-config.js';
import type { DshProfileMcpServerWire } from './types.js';

// dsh-mcp-client namespaces tools as `mcp__<serverName>__<rawName>` and
// validates serverName against [A-Za-z0-9_-]{1,32}. Daemon server ids already
// conform case-insensitively (SERVER_ID_PATTERN), so projection is a
// lowercase truncate; truncation collisions (rare) get a numeric suffix.
const DSH_MCP_SERVER_NAME_MAX = 32;
// The execute frame is one JSON line on stdio; keep the list bounded so a
// pathological MCP config cannot flood the profile's startup path.
const DSH_PROFILE_MCP_SERVER_LIMIT = 32;

function sanitizeServerName(id: string, taken: ReadonlySet<string>): string {
  const base = id.toLowerCase().slice(0, DSH_MCP_SERVER_NAME_MAX);
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 9; n++) {
    const suffixed = `${base.slice(0, DSH_MCP_SERVER_NAME_MAX - 2)}-${n}`;
    if (!taken.has(suffixed)) return suffixed;
  }
  return base; // >8 truncation collisions: keep the first-come name; the
  // plugin's own global-uniqueness check rejects the duplicate and skips it.
}

function projectStdioServer(
  server: McpServerConfig,
  name: string,
): DshProfileMcpServerWire | null {
  const command = typeof server.command === 'string' ? server.command.trim() : '';
  if (!command) {
    console.warn(
      `[dsh-profile] dropping MCP server "${server.id}": stdio transport requires a command`,
    );
    return null;
  }
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const env: Record<string, string> = {};
  for (const [envName, value] of Object.entries(server.env ?? {})) {
    if (typeof value === 'string') env[envName] = value;
  }
  return {
    id: name,
    transport: 'stdio',
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function projectRemoteServer(
  server: McpServerConfig,
  name: string,
  tokens: Record<string, string>,
): DshProfileMcpServerWire | null {
  const url = typeof server.url === 'string' ? server.url.trim() : '';
  if (!url) {
    console.warn(
      `[dsh-profile] dropping MCP server "${server.id}": ${server.transport} transport requires a url`,
    );
    return null;
  }
  // Legacy `sse` folds onto streamable-http: dsh-mcp-client has no SSE
  // transport. A server that only implements the older SSE protocol fails at
  // connect time and the plugin skips it per-server without failing the run.
  const bearer =
    effectiveMcpAuthMode(server) === 'oauth' ? tokens[server.id] : undefined;
  const headers = mergeAuthHeader(server.headers, bearer);
  return {
    id: name,
    transport: 'http',
    url,
    ...(headers ? { headers } : {}),
  };
}

/**
 * Build the `mcp_servers` entries for a DSH profile `execute` frame.
 *
 * `servers` is the merged enabled list (`resolveExternalMcpServersForRun`'s
 * `enabledServers`: run-scoped servers layered over persisted ones) and
 * `tokens` maps server id → a valid, unexpired OAuth access token, exactly
 * as prepared for the `.mcp.json` / ACP spawn paths. Invalid entries are
 * warned about and dropped rather than failing the run — a broken MCP
 * config must not take down the agent.
 */
export function buildDshProfileMcpServers(
  servers: readonly McpServerConfig[],
  tokens: Record<string, string> = {},
): DshProfileMcpServerWire[] {
  const wire: DshProfileMcpServerWire[] = [];
  const taken = new Set<string>();
  for (const server of servers) {
    if (wire.length >= DSH_PROFILE_MCP_SERVER_LIMIT) {
      console.warn(
        `[dsh-profile] dropping MCP servers beyond the ${DSH_PROFILE_MCP_SERVER_LIMIT}-server frame limit`,
      );
      break;
    }
    const name = sanitizeServerName(server.id, taken);
    const entry =
      server.transport === 'stdio'
        ? projectStdioServer(server, name)
        : projectRemoteServer(server, name, tokens);
    if (!entry) continue;
    taken.add(entry.id);
    wire.push(entry);
  }
  return wire;
}
