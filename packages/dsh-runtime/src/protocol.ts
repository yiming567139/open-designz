export const PROTOCOL_VERSION = 1 as const;
export const RUNTIME_NAME = 'open-design' as const;
export const CAPABILITIES = {
  session_resume: true,
  session_cancel: true,
  structured_events: true,
} as const;

export type ModelCatalogEntry = {
  provider: string;
  provider_name: string;
  id: string;
  name: string;
  reasoning_options?: Array<{ id: string; name: string; default?: boolean }>;
};

export function modelsFrame(models: ModelCatalogEntry[]) {
  return {
    v: PROTOCOL_VERSION,
    type: 'models' as const,
    runtime: RUNTIME_NAME,
    models,
  };
}

export type ExecuteCommand = {
  v: 1;
  type: 'execute';
  request_id: string;
  cwd: string;
  prompt: string;
  resume_session_id?: string;
  model?: { provider: string; id: string };
  reasoning_effort?: string;
  mcp_servers: unknown[];
};

export type CancelCommand = {
  v: 1;
  type: 'cancel';
  request_id: string;
};

/**
 * One run-scoped MCP server as projected by the daemon onto the execute frame.
 * `id` doubles as the mcp-client `serverName` namespace, so it must already
 * satisfy the client's `[A-Za-z0-9_-]{1,32}` contract.
 */
export type ParsedMcpServer =
  | { kind: 'stdio'; id: string; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'http'; id: string; url: string; headers: Record<string, string> };

export type ParsedMcpServers = {
  servers: ParsedMcpServer[];
  /** Per-entry diagnostics for entries that failed validation; the rest still mount. */
  dropped: string[];
};

export type HostCommand = ExecuteCommand | CancelCommand;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringRecord(value: unknown): Record<string, string> {
  const input = record(value);
  if (!input) return {};
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (typeof entry === 'string') entries[key] = entry;
  }
  return entries;
}

/**
 * Parse the execute frame's `mcp_servers` projection one entry at a time.
 * A malformed entry is reported in `dropped` and skipped; it never rejects
 * the execute command, mirroring the daemon-side per-server skip policy.
 */
export function parseMcpServers(raw: readonly unknown[]): ParsedMcpServers {
  const servers: ParsedMcpServer[] = [];
  const dropped: string[] = [];
  const drop = (index: number, reason: string) => {
    dropped.push(`mcp_servers[${index}] dropped: ${reason}`);
  };
  raw.forEach((entry, index) => {
    const input = record(entry);
    if (!input) {
      drop(index, 'mcp server must be an object');
      return;
    }
    if (!nonEmpty(input.id)) {
      drop(index, 'mcp server is missing an id');
      return;
    }
    const id = input.id;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      drop(index, `mcp server id "${id}" must match [A-Za-z0-9_-]{1,32}`);
      return;
    }
    if (input.transport === 'stdio') {
      if (!nonEmpty(input.command)) {
        drop(index, `mcp server "${id}" is missing a stdio command`);
        return;
      }
      const args = Array.isArray(input.args)
        ? input.args.filter((arg): arg is string => typeof arg === 'string')
        : [];
      servers.push({ kind: 'stdio', id, command: input.command, args, env: stringRecord(input.env) });
      return;
    }
    if (input.transport === 'http') {
      if (!nonEmpty(input.url)) {
        drop(index, `mcp server "${id}" is missing an http url`);
        return;
      }
      servers.push({ kind: 'http', id, url: input.url, headers: stringRecord(input.headers) });
      return;
    }
    drop(index, `mcp server "${id}" has no supported transport`);
  });
  return { servers, dropped };
}

export function parseHostCommand(value: unknown): HostCommand {
  const input = record(value);
  if (!input || input.v !== 1 || !nonEmpty(input.type) || !nonEmpty(input.request_id)) {
    throw new Error('invalid protocol envelope');
  }
  if (input.type === 'cancel') {
    return { v: 1, type: 'cancel', request_id: input.request_id };
  }
  if (input.type !== 'execute' || !nonEmpty(input.cwd) || !nonEmpty(input.prompt) || !Array.isArray(input.mcp_servers)) {
    throw new Error('invalid execute command');
  }
  const model = record(input.model);
  if (input.model !== undefined && (!model || !nonEmpty(model.provider) || !nonEmpty(model.id))) {
    throw new Error('invalid model selection');
  }
  if (input.resume_session_id !== undefined && !nonEmpty(input.resume_session_id)) {
    throw new Error('invalid resume session id');
  }
  if (input.reasoning_effort !== undefined && !nonEmpty(input.reasoning_effort)) {
    throw new Error('invalid reasoning effort');
  }
  return {
    v: 1,
    type: 'execute',
    request_id: input.request_id,
    cwd: input.cwd,
    prompt: input.prompt,
    mcp_servers: input.mcp_servers,
    ...(input.resume_session_id === undefined ? {} : { resume_session_id: input.resume_session_id }),
    ...(model === null ? {} : { model: { provider: model.provider as string, id: model.id as string } }),
    ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: input.reasoning_effort as string }),
  };
}

export function identityFrame(type: 'probe' | 'ready', pluginVersion: string) {
  return {
    v: PROTOCOL_VERSION,
    type,
    runtime: RUNTIME_NAME,
    protocol_version: PROTOCOL_VERSION,
    plugin_version: pluginVersion,
    capabilities: CAPABILITIES,
  };
}
