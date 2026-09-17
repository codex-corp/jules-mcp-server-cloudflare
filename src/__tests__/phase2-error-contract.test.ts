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
  const client = new Client({ name: 'phase2-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('Phase 2 structured MCP errors', () => {
  const openServers: Array<ReturnType<typeof createJulesMcpServer>> = [];
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

  async function callListSources(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status,
          statusText: status === 401 ? 'Unauthorized' : 'Upstream Error',
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = await harness();
    return client.callTool({ name: 'list_sources', arguments: {} });
  }

  it('maps upstream auth failures without leaking response bodies', async () => {
    const result = await callListSources(401, {
      error: { code: 401, status: 'UNAUTHENTICATED', message: 'private detail' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      success: false,
      error: {
        code: 'AUTH_ERROR',
        message: 'Failed to list Jules sources.',
        retryable: false,
        upstream_status: 401,
        upstream_code: 'UNAUTHENTICATED',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('maps not found and rate limit failures with retry guidance', async () => {
    const notFound = await callListSources(404, {
      error: { code: 404, status: 'NOT_FOUND' },
    });
    expect(notFound.structuredContent).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Failed to list Jules sources.',
        retryable: false,
        upstream_status: 404,
        upstream_code: 'NOT_FOUND',
      },
    });

    const limited = await callListSources(429, {
      error: { code: 429, status: 'RESOURCE_EXHAUSTED' },
    });
    expect(limited.structuredContent).toEqual({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Failed to list Jules sources.',
        retryable: true,
        upstream_status: 429,
        upstream_code: 'RESOURCE_EXHAUSTED',
      },
    });
  });

  it('marks upstream 5xx failures as retryable Jules errors', async () => {
    const result = await callListSources(503, {
      error: { code: 503, status: 'UNAVAILABLE' },
    });

    expect(result.structuredContent).toEqual({
      success: false,
      error: {
        code: 'JULES_UPSTREAM_ERROR',
        message: 'Failed to list Jules sources.',
        retryable: true,
        upstream_status: 503,
        upstream_code: 'UNAVAILABLE',
      },
    });
  });

  it('maps exhausted request timeouts to UPSTREAM_TIMEOUT', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)));

    const client = await harness();
    const result = await client.callTool({ name: 'list_sources', arguments: {} });

    expect(result.structuredContent).toEqual({
      success: false,
      error: {
        code: 'UPSTREAM_TIMEOUT',
        message: 'Failed to list Jules sources.',
        retryable: true,
      },
    });
  });

  it('uses RESPONSE_VALIDATION_ERROR for local contract failures', async () => {
    const client = await harness();
    const result = await client.callTool({
      name: 'manage_session',
      arguments: {
        session_id: 'session-1',
        action: 'send_message',
      },
    });

    expect(result.structuredContent).toEqual({
      success: false,
      error: {
        code: 'RESPONSE_VALIDATION_ERROR',
        message: 'message is required for send_message.',
        retryable: false,
      },
    });
  });
});
