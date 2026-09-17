import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

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
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await Promise.all(openServers.splice(0).map((server) => server.close()));
  });

  async function harness(bindings: Env) {
    const connected = await connectClient(bindings);
    openClients.push(connected.client);
    openServers.push(connected.server);
    return connected.client;
  }

  it('discovers the required stateless remote Jules tools', async () => {
    const client = await harness(env());
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
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
      ])
    );
    expect(names).not.toContain('wait_for_session');
    expect(names).not.toContain('schedule_recurring_task');
  });

  it('rejects likely secrets in coding and repoless prompts', async () => {
    const client = await harness(env());

    await expect(
      client.callTool({
        name: 'create_coding_task',
        arguments: {
          prompt: `Please fix this code using ${SECRET}`,
          source: 'sources/github/acme/repo',
        },
      })
    ).rejects.toThrow();

    await expect(
      client.callTool({
        name: 'create_repoless_task',
        arguments: { prompt: `Research this credential ${SECRET}` },
      })
    ).rejects.toThrow();
  });

  it('rejects likely secrets in manage_session messages', async () => {
    const client = await harness(env());

    await expect(
      client.callTool({
        name: 'manage_session',
        arguments: {
          session_id: 'session-1',
          action: 'send_message',
          message: `Use this credential ${SECRET}`,
        },
      })
    ).rejects.toThrow();
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
    expect(result.structuredContent).toEqual({
      success: false,
      error: 'Failed to create Jules coding session.',
    });
  });
});
