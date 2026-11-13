import type { Express } from 'express';
import type { LocalProjectsChangedSsePayload } from '@open-design/contracts';
import type { RouteDeps } from '../../server-context.js';

// Workspace-free delivery hop for local project catalog invalidations.
//
// The workspace invalidation stream (`/api/workspace/events`) requires a
// verified workspace identity, so a bare-local window — signed out, no
// workspace context, the packaged app's default state — can never join any
// workspace sink partition. Without this stream an MCP / od CLI / other-window
// create stayed invisible to that home until the app was restarted. This
// endpoint mirrors the `/api/library/events` and `/api/memory/events`
// pattern: a process-local listener set, one SSE connection per client, and
// content-free frames — this stream has NO workspace scope, so it must never
// carry a `projectId` (see `LocalProjectsChangedSsePayload` in contracts).

export interface RegisterLocalProjectEventRoutesDeps extends RouteDeps<'http'> {}

type LocalProjectCatalogListener = (event: string, data: unknown) => void;

// One catalog hub per daemon process, module-level like `memoryEvents`: the
// SSE clients are this process's own HTTP responses, so there is nothing to
// isolate across servers.
const catalogListeners = new Set<LocalProjectCatalogListener>();

/**
 * Fan one thin invalidation out to every connected local catalog stream.
 * Returns whether at least one subscriber received it.
 */
export function emitLocalProjectCatalogChanged(payload: LocalProjectsChangedSsePayload): boolean {
  if (catalogListeners.size === 0) return false;
  for (const listener of catalogListeners) {
    listener('local-projects-changed', payload);
  }
  return true;
}

export function registerLocalProjectEventRoutes(
  app: Express,
  ctx: RegisterLocalProjectEventRoutesDeps,
): void {
  const { createSseResponse } = ctx.http;
  // Registered BEFORE `/api/projects/:id` so the literal `events` segment wins
  // over the parameter route; `server.ts` calls this ahead of
  // `registerProjectRoutes` for exactly that reason.
  app.get('/api/projects/events', (_req, res) => {
    const sse = createSseResponse(res);
    const listener: LocalProjectCatalogListener = (event, data) => {
      sse.send(event, data);
    };
    catalogListeners.add(listener);
    // Same handshake as the workspace stream: a client can treat the stream
    // as live and reset its reconnect backoff.
    sse.send('ready', { ok: true });
    res.on('close', () => {
      catalogListeners.delete(listener);
    });
  });
}
