import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker, {
  createJulesMcpServer,
  isAuthorized,
  type Env,
} from '../worker.js';

const SECRET = 'AIza12345678901234567890123456789012345';

function env(overrides: Partial<Env> = {}): Env {
  return {
    JULES_API_KEY: 'jules-test-key',
    ...overrides,
  };
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
};

async function connectClient(bindings: Env) {
  const server = createJulesMcpServer(bindings);
  const client = new Client({ name: 'worker-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe('Cloudflare Worker HTTP surface', () => {
  it('GET /health succeeds without exposing credentials', async () => {
    const response = await worker.fetch(
      new Request('https://mcp.example.com/health'),
      env({ JULES_API_KEY: 'super-secret-jules-key' }),
      ctx
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('jules-mcp-server-cloudflare');
    expect(body).not.toContain('super-secret-jules-key');
    expect(body).not.toContain('JULES_API_KEY');
  });

  it('returns 404 for unknown routes', async () => {
    const response = await worker.fetch(
      new Request('https://mcp.example.com/nope'),
      env(),
      ctx
    );

    expect(response.status).toBe(404);
  });

  it('rejects unauthenticated /mcp requests', async () => {
    const response = await worker.fetch(
      new Request('https://mcp.example.com/mcp', { method: 'POST' }),
      env(),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it('allows LOCAL_DEV_BYPASS_AUTH only on localhost and 127.0.0.1', async () => {
    const bindings = env({ LOCAL_DEV_BYPASS_AUTH: 'true' });

    await expect(
      isAuthorized(new Request('http://localhost:8787/mcp'), bindings)
    ).resolves.toBe(true);
    await expect(
      isAuthorized(new Request('http://127.0.0.1:8787/mcp'), bindings)
    ).resolves.toBe(true);
    await expect(
      isAuthorized(new Request('https://jules.example.workers.dev/mcp'), bindings)
    ).resolves.toBe(false);
  });
});

describe('Cloudflare Worker MCP tools', () => {
  const openServers: Array<ReturnType<typeof createJulesMcpServer>> = [];
  const openClients: Client[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await Promise.all(openServers.splice(0).map((server) => server.close()));
  });

  async function harness(bindings: Env) {
    const connected = await connectClient(bindings);
    openClients.push(connected.client);
    openServers.push(connected.server);
    return connected.client;
  }

  it('discovers the required stateless remote Jules tools with output schemas', async () => {
    const client = await harness(env());
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);

    const requiredTools = [
      'create_coding_task',
      'create_repoless_task',
      'list_sessions',
      'get_session_status',
      'manage_session',
      'delete_session',
      'list_activities',
      'get_activity',
      'get_activities_since',
      'list_sources',
      'get_source_details',
    ];

    expect(names).toEqual(expect.arrayContaining(requiredTools));
    expect(names).not.toContain('wait_for_session');
    expect(names).not.toContain('schedule_recurring_task');

    for (const name of requiredTools) {
      const tool = result.tools.find((candidate) => candidate.name === name);
      expect(tool?.outputSchema).toEqual(
        expect.objectContaining({ type: 'object' })
      );
    }

    const listSessions = result.tools.find(
      (tool) => tool.name === 'list_sessions'
    );
    expect(listSessions?.annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
      })
    );

    const createTask = result.tools.find(
      (tool) => tool.name === 'create_coding_task'
    );
    expect(createTask?.annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: false,
      })
    );

    const deleteSession = result.tools.find(
      (tool) => tool.name === 'delete_session'
    );
    expect(deleteSession?.annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: true,
      })
    );
  });

  it('keeps list_sessions compact instead of forwarding large Jules payloads', async () => {
    const hugePatch = 'diff --git a/file.ts b/file.ts\n'.repeat(30000);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          sessions: [
            {
              name: 'sessions/session-1',
              id: 'session-1',
              title: 'Large completed session',
              prompt: 'Refactor the service and keep behavior unchanged.',
              state: 'COMPLETED',
              createTime: '2026-09-17T10:00:00Z',
              updateTime: '2026-09-17T10:30:00Z',
              sourceContext: {
                source: 'sources/github/acme/repo',
                githubRepoContext: { startingBranch: 'main' },
              },
              outputs: [
                {
                  changeSet: {
                    gitPatch: hugePatch,
                  },
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = await harness(env({ JULES_API_MAX_RETRIES: '0' }));
    const result = await client.callTool({
      name: 'list_sessions',
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const structured = result.structuredContent as {
      success: boolean;
      sessions: Array<Record<string, unknown>>;
    };
    expect(structured.success).toBe(true);
    expect(structured.sessions).toHaveLength(1);
    expect(structured.sessions[0]).toEqual(
      expect.objectContaining({
        id: 'session-1',
        state: 'COMPLETED',
        source: 'sources/github/acme/repo',
        branch: 'main',
      })
    );
    expect(structured.sessions[0]).not.toHaveProperty('outputs');
    expect(structured.sessions[0]).not.toHaveProperty('prompt');

    const serialized = JSON.stringify(structured);
    expect(serialized).not.toContain('gitPatch');
    expect(serialized.length).toBeLessThan(5000);
  });

  it('rejects likely secrets in coding and repoless prompts', async () => {
    const client = await harness(env());

    const coding = await client.callTool({
      name: 'create_coding_task',
      arguments: {
        prompt: `Please fix this code using ${SECRET}`,
        source: 'sources/github/acme/repo',
      },
    });
    expect(coding.isError).toBe(true);
    expect(coding.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Prompt contains potential secrets'),
        }),
      ])
    );

    const repoless = await client.callTool({
      name: 'create_repoless_task',
      arguments: { prompt: `Research this credential ${SECRET}` },
    });
    expect(repoless.isError).toBe(true);
    expect(repoless.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Prompt contains potential secrets'),
        }),
      ])
    );
  });

  it('rejects likely secrets in manage_session messages', async () => {
    const client = await harness(env());

    const result = await client.callTool({
      name: 'manage_session',
      arguments: {
        session_id: 'session-1',
        action: 'send_message',
        message: `Use this credential ${SECRET}`,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Message contains potential secrets'),
        }),
      ])
    );
  });

  it('enforces repository allowlist before Jules is called', async () => {
    const client = await harness(
      env({ JULES_ALLOWED_REPOS: 'allowed-org/allowed-repo' })
    );

    const result = await client.callTool({
      name: 'create_coding_task',
      arguments: {
        prompt: 'Please update the unit tests for this repository.',
        source: 'sources/github/other-org/other-repo',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Failed to create Jules coding session.'),
        }),
      ])
    );
  });
});
