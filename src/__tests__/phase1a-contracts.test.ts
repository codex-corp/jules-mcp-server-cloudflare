import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJulesMcpServer, type Env } from '../worker.js';

function env(overrides: Partial<Env> = {}): Env {
  return {
    JULES_API_KEY: 'jules-test-key',
    JULES_API_MAX_RETRIES: '0',
    ...overrides,
  };
}

async function connectClient(bindings: Env) {
  const server = createJulesMcpServer(bindings);
  const client = new Client({ name: 'phase1a-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe('Phase 1A connector contracts', () => {
  const openServers: Array<ReturnType<typeof createJulesMcpServer>> = [];
  const openClients: Client[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await Promise.all(openServers.splice(0).map((server) => server.close()));
  });

  async function harness(bindings: Env = env()) {
    const connected = await connectClient(bindings);
    openClients.push(connected.client);
    openServers.push(connected.server);
    return connected.client;
  }

  it('normalizes string and object defaultBranch shapes before MCP validation', async () => {
    const objectBranchSource = {
      name: 'sources/github/acme/object-repo',
      githubRepo: {
        owner: 'acme',
        repo: 'object-repo',
        htmlUrl: 'https://github.com/acme/object-repo',
        defaultBranch: { name: 'main', sha: 'deadbeef' },
      },
    };
    const stringBranchSource = {
      name: 'sources/github/acme/string-repo',
      githubRepo: {
        owner: 'acme',
        repo: 'string-repo',
        htmlUrl: 'https://github.com/acme/string-repo',
        defaultBranch: 'develop',
      },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sources: [objectBranchSource, stringBranchSource],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(objectBranchSource), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = await harness();

    const listResult = await client.callTool({
      name: 'list_sources',
      arguments: {},
    });
    expect(listResult.isError).not.toBe(true);
    expect(listResult.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        sources: [
          expect.objectContaining({
            name: 'sources/github/acme/object-repo',
            defaultBranch: 'main',
          }),
          expect.objectContaining({
            name: 'sources/github/acme/string-repo',
            defaultBranch: 'develop',
          }),
        ],
      })
    );

    const detailsResult = await client.callTool({
      name: 'get_source_details',
      arguments: { source_name: 'sources/github/acme/object-repo' },
    });
    expect(detailsResult.isError).not.toBe(true);
    expect(detailsResult.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        source: expect.objectContaining({
          name: 'sources/github/acme/object-repo',
          defaultBranch: 'main',
        }),
      })
    );
  });

  it('logs safe activity diagnostics without exposing secrets or page tokens', async () => {
    const secret = 'AIza12345678901234567890123456789012345';
    const pageToken = 'opaque-page-token-should-not-log';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: `Permission denied while using ${secret}`,
          },
        }),
        {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = await harness();
    const result = await client.callTool({
      name: 'list_activities',
      arguments: {
        session_id: 'session-1',
        page_size: 10,
        page_token: pageToken,
      },
    });

    expect(result.isError).toBe(true);

    const diagnosticCall = consoleError.mock.calls.find(
      ([label]) => label === '[jules-mcp] Jules activity request failed'
    );
    expect(diagnosticCall).toBeDefined();

    const diagnostic = diagnosticCall?.[1] as Record<string, unknown>;
    expect(diagnostic).toEqual(
      expect.objectContaining({
        operation: 'listActivities',
        endpoint: '/sessions/session-1/activities',
        status: 403,
        upstreamCode: 'PERMISSION_DENIED',
        sessionId: 'session-1',
        pageSize: 10,
        hasPageToken: true,
        responsePreview: '[redacted: potential secret detected]',
      })
    );

    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(pageToken);
    expect(serialized).not.toContain('JULES_API_KEY');
  });
});
