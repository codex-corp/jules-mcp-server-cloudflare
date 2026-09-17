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
  const client = new Client({ name: 'phase3-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

function largeSession() {
  const hugeTitle = 'Very long session title '.repeat(100);
  const hugePrompt = 'This is a very long Jules prompt used to verify output bounds. '.repeat(
    300
  );

  return {
    name: 'sessions/session-compact',
    id: 'session-compact',
    title: hugeTitle,
    prompt: hugePrompt,
    state: 'IN_PROGRESS',
    createTime: '2026-09-17T10:00:00Z',
    updateTime: '2026-09-17T10:30:00Z',
    sourceContext: {
      source: 'sources/github/acme/repo',
      githubRepoContext: { startingBranch: 'main' },
    },
    automationMode: 'AUTO_CREATE_PR',
    requirePlanApproval: false,
    outputs: Array.from({ length: 30 }, (_, index) => ({
      pullRequest: {
        url: `https://github.com/acme/repo/pull/${index + 1}`,
        title: hugeTitle,
        description: 'Large pull request description '.repeat(100),
      },
    })),
  };
}

describe('Phase 3 compact MCP responses', () => {
  const openServers: Array<ReturnType<typeof createJulesMcpServer>> = [];
  const openClients: Client[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await Promise.all(openServers.splice(0).map((server) => server.close()));
  });

  async function harness() {
    const connected = await connectClient(env());
    openClients.push(connected.client);
    openServers.push(connected.server);
    return connected.client;
  }

  it('advertises get_session_details as the explicit heavy-detail tool', async () => {
    const client = await harness();
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toContain(
      'get_session_details'
    );

    const statusTool = result.tools.find(
      (tool) => tool.name === 'get_session_status'
    );
    expect(statusTool?.description).toContain('does not return the prompt');
  });

  it('keeps list_sessions bounded and removes prompt previews', async () => {
    const session = largeSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ sessions: [session] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'list_sessions',
      arguments: { page_size: 20 },
    });

    const structured = result.structuredContent as {
      success: boolean;
      sessions: Array<Record<string, unknown>>;
    };
    const item = structured.sessions[0];

    expect(structured.success).toBe(true);
    expect(item).toEqual(
      expect.objectContaining({
        id: 'session-compact',
        state: 'IN_PROGRESS',
        source: 'sources/github/acme/repo',
        branch: 'main',
      })
    );
    expect(String(item.title).length).toBeLessThanOrEqual(160);
    expect(item).not.toHaveProperty('prompt');
    expect(item).not.toHaveProperty('promptPreview');
    expect(item).not.toHaveProperty('outputs');
    expect(item).not.toHaveProperty('name');
    expect(item).not.toHaveProperty('monitorUrl');
    expect(JSON.stringify(structured).length).toBeLessThan(800);
  });

  it('keeps get_session_status polling-safe and prompt-free', async () => {
    const session = largeSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'get_session_status',
      arguments: { session_id: 'session-compact' },
    });

    const structured = result.structuredContent as {
      success: boolean;
      session: Record<string, unknown>;
    };

    expect(structured.success).toBe(true);
    expect(structured.session).toEqual(
      expect.objectContaining({
        id: 'session-compact',
        state: 'IN_PROGRESS',
        updateTime: '2026-09-17T10:30:00Z',
      })
    );
    expect(structured.session).not.toHaveProperty('prompt');
    expect(structured.session).not.toHaveProperty('promptPreview');
    expect(structured.session).not.toHaveProperty('title');
    expect(structured.session).not.toHaveProperty('source');
    expect(structured.session).not.toHaveProperty('outputs');
    expect(JSON.stringify(structured).length).toBeLessThan(500);
  });

  it('moves bounded prompt and PR metadata to get_session_details', async () => {
    const session = largeSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'get_session_details',
      arguments: { session_id: 'session-compact' },
    });

    const structured = result.structuredContent as {
      success: boolean;
      session: {
        title?: string;
        prompt: string;
        promptTruncated: boolean;
        pullRequests: Array<{ url: string; title?: string }>;
      };
    };

    expect(structured.success).toBe(true);
    expect(structured.session.promptTruncated).toBe(true);
    expect(structured.session.prompt.length).toBeLessThanOrEqual(4000);
    expect(structured.session.title?.length).toBeLessThanOrEqual(160);
    expect(structured.session.pullRequests).toHaveLength(20);
    expect(
      structured.session.pullRequests.every(
        (pullRequest) => !pullRequest.title || pullRequest.title.length <= 160
      )
    ).toBe(true);
    expect(JSON.stringify(structured)).not.toContain(
      'Large pull request description'
    );
  });

  it('keeps manage_session responses compact after send_message', async () => {
    const session = largeSession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = await harness();
    const result = await client.callTool({
      name: 'manage_session',
      arguments: {
        session_id: 'session-compact',
        action: 'send_message',
        message: 'Continue with the current plan.',
      },
    });

    const structured = result.structuredContent as {
      success: boolean;
      session: Record<string, unknown>;
    };

    expect(structured.success).toBe(true);
    expect(structured.session).not.toHaveProperty('prompt');
    expect(structured.session).not.toHaveProperty('promptPreview');
    expect(structured.session).not.toHaveProperty('title');
    expect(JSON.stringify(structured).length).toBeLessThan(600);
  });

  it('bounds compact activity summaries to 500 characters', async () => {
    const longMessage = 'Agent progress details. '.repeat(100);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            activities: [
              {
                name: 'sessions/session-compact/activities/activity-1',
                createTime: '2026-09-17T10:31:00Z',
                agentMessaged: { agentMessage: longMessage },
              },
            ],
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
      name: 'list_activities',
      arguments: { session_id: 'session-compact', page_size: 20 },
    });

    const structured = result.structuredContent as {
      success: boolean;
      activities: Array<{ summary?: string }>;
    };

    expect(structured.success).toBe(true);
    expect(structured.activities[0].summary?.length).toBeLessThanOrEqual(500);
  });
});
