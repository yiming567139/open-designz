// @vitest-environment node

// INVARIANT UNDER TEST: creating a project through POST /api/projects must
// broadcast a thin `local-projects-changed` invalidation over BOTH delivery
// channels, so an already-open web home learns to re-fetch its project list
// without a restart or a view switch. MCP, the od CLI, and other windows
// create projects through the same daemon route, so one broadcast covers every
// external creator.
//
//   * The workspace event stream (`/api/workspace/events`) carries workspace-
//     scoped delivery for signed-in windows. A workspace-bound create emits
//     into its own workspace scope and names the created project (`projectId`);
//     a headerless (CLI/MCP/legacy) create has no workspace scope, so it fans
//     out as a content-free nudge — carrying a `projectId` there would leak
//     one workspace's project onto every other workspace's stream.
//   * The workspace-free local catalog stream (`/api/projects/events`) is the
//     ONLY push channel a bare-local (signed-out, no workspace context) web
//     home has: the workspace stream requires a verified workspace identity,
//     so without this stream an MCP/CLI create stays invisible there until the
//     app is restarted. It must be content-free for headerless creates for the
//     same leak reason as above.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite } from '@/vitest/suite';

type CreatedProject = { conversationId: string; project: { id: string; name: string } };
type SseFrame = { event: string; data: unknown };

/** The daemon's only directory member: the signed-in personal workspace. */
const MEMBERSHIP = {
  workspaceId: 'ws-lpc-personal',
  workspaceName: 'Local projects personal',
  workspaceType: 'personal' as const,
  workspaceMemberId: 'mem-lpc-personal',
  role: 'owner' as const,
  memberStatus: 'active' as const,
  lifecycleState: 'active' as const,
};

let directoryServer: Server;
let directoryUrl: string;

beforeAll(async () => {
  // The daemon's real vela session inputs are pointed at this mock so both
  // workspace-bound creation and the SSE handshake verify against a directory
  // this spec controls, never against the developer machine's real login.
  directoryServer = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/workspaces') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [MEMBERSHIP] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => directoryServer.listen(0, '127.0.0.1', resolve));
  const address = directoryServer.address();
  if (address == null || typeof address === 'string') throw new Error('mock directory has no port');
  directoryUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => directoryServer.close(() => resolve()));
});

function workspaceHeaders(input: {
  workspaceId: string;
  workspaceMemberId: string;
  workspaceType: 'personal' | 'team';
  role?: string;
}): Record<string, string> {
  return {
    'x-od-workspace-id': input.workspaceId,
    'x-od-workspace-type': input.workspaceType,
    'x-od-workspace-member-id': input.workspaceMemberId,
    'x-od-workspace-role': input.role ?? 'owner',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-can-share-projects': 'true',
    'x-od-workspace-can-write-synced-files': 'true',
  };
}

/**
 * A vela config home guaranteed to hold no session, so the daemon's
 * `readVelaControlApiContext` config-file fallback cannot pick up the developer
 * machine's real production login.
 */
async function emptyAmrHome(scratchDir: string): Promise<string> {
  const dir = join(scratchDir, 'empty-amr-home');
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createProject(input: {
  webUrl: string;
  name: string;
  headers?: Record<string, string>;
}): Promise<CreatedProject> {
  return await requestJson<CreatedProject>(input.webUrl, '/api/projects', {
    body: {
      designSystemId: null,
      id: randomUUID(),
      metadata: { kind: 'prototype' },
      name: input.name,
      pendingPrompt: null,
      skillId: null,
    },
    method: 'POST',
    ...(input.headers ? { headers: input.headers } : {}),
  });
}

function describeSeen(events: readonly string[]): string {
  return events.length === 0 ? '(none)' : events.join(', ');
}

/** The daemon frames every message as `event: <type>\ndata: <json>\n\n`. */
function parseSseFrame(raw: string): SseFrame | null {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // keepalive comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
  }
  if (data === '') return null;
  try {
    return { event, data: JSON.parse(data) as unknown };
  } catch {
    return { event, data };
  }
}

/**
 * Subscribe to the workspace event stream with a plain Node fetch and parse
 * frames incrementally (never assuming chunk alignment). `next()` awaits the
 * following frame and fails with the frames already seen, so a timeout names
 * its cause instead of surfacing as an opaque deadline.
 */
function subscribeWorkspaceEvents(input: {
  webUrl: string;
  /** SSE path on the daemon; defaults to the workspace invalidation stream. */
  path?: string;
  headers?: Record<string, string>;
}): {
  next: (timeoutMs: number, expecting: string) => Promise<SseFrame>;
  close: () => void;
} {
  const streamPath = input.path ?? '/api/workspace/events';
  const controller = new AbortController();
  const queue: SseFrame[] = [];
  const seenEvents: string[] = [];
  let waiter: { resolve: (frame: SseFrame) => void; reject: (error: Error) => void } | null = null;
  let failure: Error | null = null;
  let ended = false;
  let buffer = '';

  const deliver = (frame: SseFrame): void => {
    seenEvents.push(frame.event);
    if (waiter != null) {
      const pending = waiter;
      waiter = null;
      pending.resolve(frame);
      return;
    }
    queue.push(frame);
  };

  void (async () => {
    let pumpError: Error | null = null;
    try {
      const response = await fetch(new URL(streamPath, input.webUrl), {
        headers: { accept: 'text/event-stream', ...input.headers },
        signal: controller.signal,
      });
      if (!response.ok || response.body == null) {
        throw new Error(`${streamPath} event stream answered HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary < 0) break;
          const frame = parseSseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (frame != null) deliver(frame);
        }
      }
      ended = true;
    } catch (error) {
      if (controller.signal.aborted) return;
      pumpError = error instanceof Error ? error : new Error(String(error));
    }
    if (pumpError != null) {
      failure = pumpError;
      if (waiter != null) {
        const pending = waiter;
        waiter = null;
        pending.reject(pumpError);
      }
    }
  })();

  return {
    next(timeoutMs, expecting) {
      const queued = queue.shift();
      if (queued != null) return Promise.resolve(queued);
      if (failure != null) return Promise.reject(failure);
      if (ended) {
        return Promise.reject(new Error(
          `workspace event stream closed before "${expecting}"; frames seen: ${describeSeen(seenEvents)}`,
        ));
      }
      return new Promise<SseFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          controller.abort();
          reject(new Error(
            `no "${expecting}" event within ${timeoutMs}ms; frames seen: ${describeSeen(seenEvents)}`,
          ));
        }, timeoutMs);
        waiter = {
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
      });
    },
    close() {
      controller.abort();
    },
  };
}

describe('POST /api/projects invalidates open project lists over SSE', () => {
  test(
    '[P0] every create shape broadcasts local-projects-changed to subscribed workspace streams',
    { timeout: 300_000 },
    async () => {
      const suite = await createSmokeSuite('projects-local-projects-changed');

      await suite.with.toolsDev(
        async ({ webUrl }) => {
          const stream = subscribeWorkspaceEvents({
            webUrl,
            headers: workspaceHeaders(MEMBERSHIP),
          });

          try {
            const ready = await stream.next(30_000, 'ready');
            expect(
              ready.event,
              'the workspace stream must complete its handshake before any create',
            ).toBe('ready');

            // Shape 1: a workspace-bound create notifies its own workspace
            // scope and names the created project.
            const bound = await createProject({
              webUrl,
              name: 'Local projects bound create',
              headers: workspaceHeaders(MEMBERSHIP),
            });
            const boundEvent = await stream.next(15_000, 'local-projects-changed');
            expect(
              boundEvent.event,
              'a workspace-bound create must emit local-projects-changed on its workspace stream',
            ).toBe('local-projects-changed');
            expect(
              boundEvent.data,
              'the bound create may name the created project as the invalidation target',
            ).toMatchObject({ projectId: bound.project.id });
            const boundAt = (boundEvent.data as { at?: unknown }).at;
            if (boundAt !== undefined) {
              expect(typeof boundAt === 'number' && Number.isFinite(boundAt)).toBe(true);
            }

            // Shape 2: a headerless create (od CLI / MCP / legacy callers) has
            // no workspace scope, so it must fan out as a content-free nudge.
            // The bound event above was already consumed, so the next event on
            // this stream can only come from the headerless create — a second
            // broadcast for shape 1 would fail this wait with the wrong id.
            const headerless = await createProject({
              webUrl,
              name: 'Local projects headerless create',
            });
            const headerlessEvent = await stream.next(15_000, 'local-projects-changed');
            expect(
              headerlessEvent.event,
              'a headerless create must still emit local-projects-changed so open lists re-fetch',
            ).toBe('local-projects-changed');
            expect(
              'projectId' in (headerlessEvent.data as object),
              'a headerless create must not claim a projectId across every workspace stream',
            ).toBe(false);
            expect(
              headerless.project.id,
              'the headerless create itself must still succeed — only the notification is under test',
            ).toBeTruthy();

            // Bare-local delivery: the workspace-free local catalog stream is
            // the ONLY push channel a signed-out web home has. It must receive
            // the same headerless create as a content-free nudge — the stream
            // has no workspace scope, so naming a project there would leak it
            // across every scope that ever subscribes.
            const localStream = subscribeWorkspaceEvents({
              webUrl,
              path: '/api/projects/events',
            });
            try {
              const localReady = await localStream.next(30_000, 'ready');
              expect(
                localReady.event,
                'the local catalog stream must complete its handshake before any create',
              ).toBe('ready');
              const bareLocal = await createProject({
                webUrl,
                name: 'Local projects bare-local stream create',
              });
              const localEvent = await localStream.next(15_000, 'local-projects-changed');
              expect(
                localEvent.event,
                'a headerless create must emit local-projects-changed on the workspace-free local catalog stream',
              ).toBe('local-projects-changed');
              expect(
                'projectId' in (localEvent.data as object),
                'the local catalog stream has no workspace scope; a headerless create must not name a project there',
              ).toBe(false);
              expect(
                bareLocal.project.id,
                'the bare-local create itself must still succeed — only the notification is under test',
              ).toBeTruthy();
            } finally {
              localStream.close();
            }
          } finally {
            stream.close();
          }
        },
        {
          env: {
            AMR_HOME: await emptyAmrHome(suite.scratchDir),
            OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
            VELA_API_URL: directoryUrl,
            VELA_CONTROL_KEY: 'e2e-local-projects-control-key',
          },
        },
      );
    },
  );
});
