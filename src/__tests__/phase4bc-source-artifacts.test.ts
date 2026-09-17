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
  const client = new Client({ name: 'phase4bc-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

function sourceDto() {
  return {
    name: 'sources/github-acme-repo',
    id: 'github-acme-repo',
    githubRepo: {
      owner: 'acme',
      repo: 'repo',
      isPrivate: true,
      defaultBranch: { displayName: 'main' },
      branches: [
        { displayName: 'main' },
        { displayName: 'develop' },
        { name: 'legacy-name-shape' },
      ],
    },
  };
}

function artifactActivity() {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old value',
    '+new value',
  ].join('\n');

  return {
    name: 'sessions/s1/activities/a1',
    id: 'a1',
    originator: 'agent',
    description: 'Code changes are ready.',
    createTime: '2026-09-17T10:00:00Z',
    planApproved: { planId: 'plan-123' },
    artifacts: [
      {
        changeSet: {
          source: 'sources/github-acme-repo',
          gitPatch: {
            baseCommitId: 'abc123',
            unidiffPatch: patch,
            suggestedCommitMessage: 'Update a.ts',
          },
        },
      },
      {
        bashOutput: {
          command: 'npm test',
          output: 'x'.repeat(3000),
          exitCode: 0,
        },
      },
      {
        media: {
          mimeType: 'image/png',
          data: 'BASE64_MUST_NOT_ESCAPE',
          description: 'Screenshot',
        },
      },
    ],
  };
}

describe('Phase 4B source completeness and identity', () => {
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

  it('accepts opaque source names and exposes current Jules source metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(sourceDto()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'get_source_details',
      arguments: { source_name: 'sources/github-acme-repo' },
    });

    expect(result.structuredContent).toEqual({
      success: true,
      source: {
        name: 'sources/github-acme-repo',
        id: 'github-acme-repo',
        owner: 'acme',
        repo: 'repo',
        isPrivate: true,
        defaultBranch: 'main',
        branches: ['main', 'develop', 'legacy-name-shape'],
        branchesTruncated: false,
      },
    });
  });

  it('keeps list_sources compact and excludes branch arrays', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ sources: [sourceDto()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = await harness();
    const result = await client.callTool({
      name: 'list_sources',
      arguments: { page_size: 20 },
    });
    const serialized = JSON.stringify(result.structuredContent);

    expect(serialized).toContain('github-acme-repo');
    expect(serialized).not.toContain('legacy-name-shape');
    expect(serialized).not.toContain('branchesTruncated');
  });

  it('validates the allowlist against resolved GitHub identity, not source text', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          name: 'sources/github-acme-repo',
          id: 'github-acme-repo',
          githubRepo: {
            owner: 'attacker',
            repo: 'different-repo',
            defaultBranch: { displayName: 'main' },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = await harness(
      env({ JULES_ALLOWED_REPOS: 'acme/repo' })
    );
    const result = await client.callTool({
      name: 'create_coding_task',
      arguments: {
        prompt: 'Please update the tests without changing behavior.',
        source: 'sources/github-acme-repo',
        branch: 'main',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      success: false,
      error: {
        code: 'AUTH_ERROR',
        message: 'Failed to create Jules coding session.',
        retryable: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 4C explicit activity artifacts', () => {
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

  function stubActivity() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(artifactActivity()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
  }

  it('advertises explicit read-only artifact and patch tools', async () => {
    const client = await harness();
    const tools = await client.listTools();

    for (const name of ['get_activity_artifacts', 'get_activity_patch']) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.annotations).toEqual(
        expect.objectContaining({ readOnlyHint: true, destructiveHint: false })
      );
    }
  });

  it('keeps get_activity bounded while exposing high-value metadata', async () => {
    stubActivity();
    const client = await harness();
    const result = await client.callTool({
      name: 'get_activity',
      arguments: { session_id: 's1', activity_id: 'a1' },
    });
    const serialized = JSON.stringify(result.structuredContent);

    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        activity: expect.objectContaining({
          originator: 'agent',
          planId: 'plan-123',
          hasArtifacts: true,
          artifactCounts: {
            changeSets: 1,
            bashOutputs: 1,
            media: 1,
          },
        }),
      })
    );
    expect(serialized).not.toContain('diff --git');
    expect(serialized).not.toContain('BASE64_MUST_NOT_ESCAPE');
    expect(serialized).not.toContain('xxx');
  });

  it('returns bounded artifact metadata without raw patch or media bytes', async () => {
    stubActivity();
    const client = await harness();
    const result = await client.callTool({
      name: 'get_activity_artifacts',
      arguments: { session_id: 's1', activity_id: 'a1' },
    });
    const structured = result.structuredContent as {
      artifacts: {
        changeSets: Array<Record<string, unknown>>;
        bashOutputs: Array<Record<string, unknown>>;
        media: Array<Record<string, unknown>>;
      };
    };
    const serialized = JSON.stringify(structured);

    expect(structured.artifacts.changeSets[0]).toEqual(
      expect.objectContaining({
        baseCommitId: 'abc123',
        suggestedCommitMessage: 'Update a.ts',
        changedFiles: ['src/a.ts'],
        patchAvailable: true,
      })
    );
    expect(structured.artifacts.bashOutputs[0]).toEqual(
      expect.objectContaining({
        command: 'npm test',
        exitCode: 0,
        outputTruncated: true,
        outputChars: 3000,
      })
    );
    expect(structured.artifacts.media[0]).toEqual(
      expect.objectContaining({ mimeType: 'image/png', dataAvailable: true })
    );
    expect(serialized).not.toContain('diff --git');
    expect(serialized).not.toContain('BASE64_MUST_NOT_ESCAPE');
  });

  it('chunks raw patches only through get_activity_patch', async () => {
    stubActivity();
    const client = await harness();
    const result = await client.callTool({
      name: 'get_activity_patch',
      arguments: {
        session_id: 's1',
        activity_id: 'a1',
        change_set_index: 0,
        offset: 0,
        max_chars: 20,
      },
    });
    const structured = result.structuredContent as {
      patchChunk: string;
      hasMore: boolean;
      nextOffset?: number;
      totalChars: number;
    };

    expect(structured.patchChunk.length).toBeLessThanOrEqual(20);
    expect(structured.hasMore).toBe(true);
    expect(structured.nextOffset).toBe(20);
    expect(structured.totalChars).toBeGreaterThan(20);
    expect(JSON.stringify(structured)).not.toContain('BASE64_MUST_NOT_ESCAPE');
  });
});
