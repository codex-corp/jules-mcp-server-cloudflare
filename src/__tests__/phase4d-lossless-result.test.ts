import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chunkActivityContent,
  createRemoteJulesMcpServer,
} from '../remote-worker.js';
import type { Env } from '../worker.js';

function env(overrides: Partial<Env> = {}): Env {
  return {
    JULES_API_KEY: 'jules-test-key',
    JULES_API_MAX_RETRIES: '0',
    ...overrides,
  };
}

async function connectClient(bindings: Env) {
  const server = createRemoteJulesMcpServer(bindings);
  const client = new Client({ name: 'phase4d-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe('Phase 4D lossless result retrieval', () => {
  const openServers: Array<ReturnType<typeof createRemoteJulesMcpServer>> = [];
  const openClients: Client[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await Promise.all(openServers.splice(0).map((server) => server.close()));
  });

  async function harness(bindings: Env = env()) {
    const connected = await connectClient(bindings);
    openClients.push(connected.client);
    openServers.push(connected.server);
    return connected.client;
  }

  it('advertises get_activity_content as a bounded read-only tool', async () => {
    const client = await harness();
    const result = await client.listTools();
    const tool = result.tools.find(
      (candidate) => candidate.name === 'get_activity_content'
    );

    expect(tool).toBeDefined();
    expect(tool?.annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
      })
    );
    expect(tool?.inputSchema.properties).toEqual(
      expect.objectContaining({
        offset: expect.objectContaining({ minimum: 0 }),
        max_chars: expect.objectContaining({ maximum: 20000 }),
      })
    );
    expect(tool?.outputSchema).toEqual(
      expect.objectContaining({ type: 'object' })
    );
  });

  it('reassembles a long agent message exactly across Unicode-safe chunks', async () => {
    const fullText =
      'Root cause A ✅ — العربية محفوظة. ' +
      'Detailed reasoning with code symbols and test expectations. '.repeat(40) +
      'Final marker 🚀';

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          name: 'sessions/session-1/activities/activity-1',
          createTime: '2026-09-17T18:40:55.378263Z',
          agentMessaged: { agentMessage: fullText },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = await harness();
    const chunks: string[] = [];
    let offset = 0;
    let hasMore = true;
    let totalChars = 0;

    while (hasMore) {
      const result = await client.callTool({
        name: 'get_activity_content',
        arguments: {
          session_id: 'session-1',
          activity_id: 'activity-1',
          offset,
          max_chars: 97,
        },
      });

      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as {
        success: boolean;
        contentAvailable: boolean;
        contentType: string;
        contentChunk: string;
        nextOffset?: number;
        hasMore: boolean;
        totalChars: number;
      };

      expect(structured.success).toBe(true);
      expect(structured.contentAvailable).toBe(true);
      expect(structured.contentType).toBe('agent_message');
      chunks.push(structured.contentChunk);
      totalChars = structured.totalChars;
      hasMore = structured.hasMore;
      offset = structured.nextOffset ?? totalChars;
    }

    expect(chunks.join('')).toBe(fullText);
    expect(totalChars).toBe(Array.from(fullText).length);
    expect(fetchMock).toHaveBeenCalledTimes(chunks.length);
  });

  it('never splits a surrogate pair at a chunk boundary', () => {
    const content = 'ab😀cd🚀ef';
    const first = chunkActivityContent(content, 0, 3);
    const second = chunkActivityContent(
      content,
      first.nextOffset ?? first.totalChars,
      3
    );
    const third = chunkActivityContent(
      content,
      second.nextOffset ?? second.totalChars,
      3
    );

    expect(first.contentChunk).toBe('ab😀');
    expect(`${first.contentChunk}${second.contentChunk}${third.contentChunk}`).toBe(
      content
    );
    expect(first.totalChars).toBe(8);
  });

  it('returns only sanitized final agent text when upstream contains trace markers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            name: 'sessions/session-1/activities/activity-2',
            createTime: '2026-09-17T18:44:06.320518Z',
            agentMessaged: {
              agentMessage:
                '闸thought\nprivate reasoning\n闸final\nVisible critique only.',
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'get_activity_content',
      arguments: {
        session_id: 'session-1',
        activity_id: 'activity-2',
      },
    });
    const structured = result.structuredContent as {
      contentChunk: string;
      contentType: string;
    };

    expect(structured.contentType).toBe('agent_message');
    expect(structured.contentChunk).toBe('Visible critique only.');
    expect(structured.contentChunk).not.toContain('private reasoning');
    expect(structured.contentChunk).not.toContain('闸thought');
  });

  it('returns contentAvailable=false for an activity without user-visible text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            name: 'sessions/session-1/activities/activity-3',
            createTime: '2026-09-17T18:45:00Z',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'get_activity_content',
      arguments: {
        session_id: 'session-1',
        activity_id: 'activity-3',
      },
    });

    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        contentAvailable: false,
        contentChunk: '',
        hasMore: false,
        totalChars: 0,
      })
    );
  });

  it('preserves the structured NOT_FOUND error contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 404,
              status: 'NOT_FOUND',
              message: 'Activity not found',
            },
          }),
          {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'get_activity_content',
      arguments: {
        session_id: 'session-1',
        activity_id: 'missing',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Failed to get Jules activity content.',
        retryable: false,
        upstream_status: 404,
        upstream_code: 'NOT_FOUND',
      },
    });
  });
});
