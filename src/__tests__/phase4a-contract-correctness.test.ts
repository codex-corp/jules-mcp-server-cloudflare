import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJulesMcpServer, type Env } from '../worker.js';

function env(): Env {
  return {
    JULES_API_KEY: 'jules-test-key',
    JULES_API_MAX_RETRIES: '0',
  };
}

async function connectClient() {
  const server = createJulesMcpServer(env());
  const client = new Client({ name: 'phase4a-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe('Phase 4A contract correctness', () => {
  const openServers: Array<ReturnType<typeof createJulesMcpServer>> = [];
  const openClients: Client[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await Promise.all(openServers.splice(0).map((server) => server.close()));
  });

  async function harness() {
    const connected = await connectClient();
    openClients.push(connected.client);
    openServers.push(connected.server);
    return connected.client;
  }

  it('caps all remote pagination inputs at the Jules API maximum of 100', async () => {
    const client = await harness();
    const result = await client.listTools();

    for (const toolName of [
      'list_sessions',
      'list_activities',
      'get_activities_since',
      'list_sources',
    ]) {
      const tool = result.tools.find((candidate) => candidate.name === toolName);
      expect(tool).toBeDefined();

      const schema = tool?.inputSchema as {
        properties?: { page_size?: { maximum?: number } };
      };
      expect(schema.properties?.page_size?.maximum).toBe(100);
    }
  });

  it('does not advertise reject_plan as a manage_session action', async () => {
    const client = await harness();
    const result = await client.listTools();
    const tool = result.tools.find(
      (candidate) => candidate.name === 'manage_session'
    );

    const schema = tool?.inputSchema as {
      properties?: { action?: { enum?: string[] } };
    };

    expect(schema.properties?.action?.enum).toEqual([
      'approve_plan',
      'send_message',
    ]);
    expect(schema.properties?.action?.enum).not.toContain('reject_plan');
  });

  it('continues get_activities_since without silently dropping excess matches', async () => {
    const activities = [
      {
        name: 'sessions/s1/activities/a1',
        createTime: '2026-09-17T10:00:01Z',
        progressUpdated: { message: 'one' },
      },
      {
        name: 'sessions/s1/activities/a2',
        createTime: '2026-09-17T10:00:02Z',
        progressUpdated: { message: 'two' },
      },
      {
        name: 'sessions/s1/activities/a3',
        createTime: '2026-09-17T10:00:03Z',
        progressUpdated: { message: 'three' },
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ activities }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = await harness();
    const first = await client.callTool({
      name: 'get_activities_since',
      arguments: {
        session_id: 's1',
        since: '2026-09-17T10:00:00Z',
        page_size: 2,
      },
    });

    const firstStructured = first.structuredContent as {
      success: boolean;
      activities: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };

    expect(firstStructured.success).toBe(true);
    expect(firstStructured.activities.map((activity) => activity.id)).toEqual([
      'a1',
      'a2',
    ]);
    expect(firstStructured.hasMore).toBe(true);
    expect(firstStructured.nextCursor).toBeTruthy();

    const second = await client.callTool({
      name: 'get_activities_since',
      arguments: {
        session_id: 's1',
        since: '2026-09-17T10:00:00Z',
        page_size: 2,
        cursor: firstStructured.nextCursor,
      },
    });

    const secondStructured = second.structuredContent as {
      success: boolean;
      activities: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };

    expect(secondStructured.success).toBe(true);
    expect(secondStructured.activities.map((activity) => activity.id)).toEqual([
      'a3',
    ]);
    expect(secondStructured.hasMore).toBe(false);
    expect(secondStructured.nextCursor).toBeUndefined();
  });
});
