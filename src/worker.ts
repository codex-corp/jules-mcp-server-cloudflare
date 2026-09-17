import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import { JulesClient } from './api/jules-client.js';

interface Env {
  JULES_API_KEY: string;
  JULES_ALLOWED_REPOS?: string;
  JULES_API_TIMEOUT_MS?: string;
  JULES_API_MAX_RETRIES?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  LOCAL_DEV_BYPASS_AUTH?: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const VERSION = '1.0.0';

const sessionIdSchema = z
  .string()
  .regex(/^[\w-]+$/, 'Session ID contains invalid characters');

const sourceNameSchema = z
  .string()
  .regex(
    /^sources\/github\/[\w-]+\/[\w-]+$/,
    'Source must be in format sources/github/owner/repo'
  );

const activityIdSchema = z
  .string()
  .regex(/^[\w-]+$/, 'Activity ID contains invalid characters');

const createCodingTaskSchema = {
  prompt: z.string().min(10).max(10000),
  source: sourceNameSchema,
  branch: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/)
    .max(255)
    .default('main'),
  auto_create_pr: z.boolean().default(true),
  require_plan_approval: z.boolean().default(false),
  title: z.string().max(200).optional(),
};

const createRepolessTaskSchema = {
  prompt: z.string().min(10).max(10000),
  title: z.string().max(200).optional(),
};

const manageSessionSchema = {
  session_id: sessionIdSchema,
  action: z.enum(['approve_plan', 'send_message', 'reject_plan']),
  message: z.string().min(1).max(5000).optional(),
};

const paginationSchema = {
  page_size: z.number().int().min(1).max(200).default(50),
  page_token: z.string().optional(),
};

const getActivitiesSinceSchema = {
  session_id: sessionIdSchema,
  since: z.string().datetime({ offset: true }),
  page_size: z.number().int().min(1).max(200).default(50),
};

/**
 * Return a backwards-compatible MCP result with both JSON text and structured data.
 * @param value - JSON object returned by Jules.
 * @returns MCP tool result.
 */
function jsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/**
 * Return a generic error without exposing credentials, upstream bodies, or internals.
 * @param message - Safe error message.
 * @returns MCP error result.
 */
function errorResult(message: string) {
  const value = { success: false, error: message };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

/**
 * Enforce the optional repository allowlist using Worker bindings.
 * @param source - Jules source resource name.
 * @param allowlist - Comma-separated owner/repo allowlist.
 */
function validateRepository(source: string, allowlist?: string): void {
  if (!allowlist) return;

  const allowed = allowlist
    .split(',')
    .map((repo) => repo.trim())
    .filter(Boolean);

  if (allowed.length === 0) return;

  const repository = source.replace(/^sources\/github\//, '');
  if (!allowed.includes(repository)) {
    throw new Error('Repository is not authorized for this MCP server.');
  }
}

/**
 * Create a request-scoped Jules client from Cloudflare bindings.
 * @param env - Worker bindings.
 * @returns Configured Jules client.
 */
function createJulesClient(env: Env): JulesClient {
  return new JulesClient({
    apiKey: env.JULES_API_KEY,
    timeoutMs: env.JULES_API_TIMEOUT_MS
      ? Number(env.JULES_API_TIMEOUT_MS)
      : undefined,
    maxRetries: env.JULES_API_MAX_RETRIES
      ? Number(env.JULES_API_MAX_RETRIES)
      : undefined,
  });
}

/**
 * Register stateless Jules tools for the remote Worker MCP endpoint.
 * Local scheduling and polling are intentionally not exposed in the Worker.
 * @param env - Worker bindings.
 * @returns Fresh MCP server for one stateless request.
 */
export function createJulesMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'jules-mcp-server-cloudflare',
    version: VERSION,
  });

  server.registerTool(
    'create_coding_task',
    {
      description: 'Create a Jules coding session for a connected repository.',
      inputSchema: createCodingTaskSchema,
    },
    async (args) => {
      try {
        validateRepository(args.source, env.JULES_ALLOWED_REPOS);
        const client = createJulesClient(env);
        const session = await client.createSession({
          prompt: args.prompt,
          sourceContext: {
            source: args.source,
            githubRepoContext: { startingBranch: args.branch },
          },
          automationMode: args.auto_create_pr
            ? 'AUTO_CREATE_PR'
            : 'AUTOMATION_MODE_UNSPECIFIED',
          requirePlanApproval: args.require_plan_approval,
          title: args.title,
        });

        return jsonResult({
          success: true,
          sessionId: session.id,
          state: session.state,
          monitorUrl:
            session.url || `https://jules.google.com/sessions/${session.id}`,
        });
      } catch {
        return errorResult('Failed to create Jules coding session.');
      }
    }
  );

  server.registerTool(
    'create_repoless_task',
    {
      description: 'Create a Jules session without repository context.',
      inputSchema: createRepolessTaskSchema,
    },
    async (args) => {
      try {
        const session = await createJulesClient(env).createSession({
          prompt: args.prompt,
          title: args.title,
        });
        return jsonResult({
          success: true,
          sessionId: session.id,
          state: session.state,
          monitorUrl:
            session.url || `https://jules.google.com/sessions/${session.id}`,
        });
      } catch {
        return errorResult('Failed to create Jules session.');
      }
    }
  );

  server.registerTool(
    'list_sessions',
    {
      description: 'List Jules sessions.',
      inputSchema: paginationSchema,
    },
    async ({ page_size, page_token }) => {
      try {
        const result = await createJulesClient(env).listSessions(
          page_size,
          page_token
        );
        return jsonResult({
          success: true,
          sessions: result.sessions,
          nextPageToken: result.nextPageToken,
        });
      } catch {
        return errorResult('Failed to list Jules sessions.');
      }
    }
  );

  server.registerTool(
    'get_session_status',
    {
      description: 'Get the current state and details of a Jules session.',
      inputSchema: { session_id: sessionIdSchema },
    },
    async ({ session_id }) => {
      try {
        const session = await createJulesClient(env).getSession(session_id);
        return jsonResult({ success: true, session });
      } catch {
        return errorResult('Failed to get Jules session.');
      }
    }
  );

  server.registerTool(
    'manage_session',
    {
      description:
        'Approve a Jules plan, send a message to a session, or reject a plan.',
      inputSchema: manageSessionSchema,
    },
    async ({ session_id, action, message }) => {
      try {
        const client = createJulesClient(env);
        if (action === 'approve_plan') {
          const session = await client.approvePlan(session_id);
          return jsonResult({ success: true, session });
        }
        if (action === 'send_message') {
          if (!message) return errorResult('message is required for send_message.');
          const session = await client.sendMessage(session_id, { prompt: message });
          return jsonResult({ success: true, session });
        }

        await client.rejectPlan(session_id);
        return jsonResult({
          success: true,
          sessionId: session_id,
          state: 'CANCELED',
        });
      } catch {
        return errorResult('Failed to manage Jules session.');
      }
    }
  );

  server.registerTool(
    'delete_session',
    {
      description: 'Delete or cancel a Jules session.',
      inputSchema: { session_id: sessionIdSchema },
    },
    async ({ session_id }) => {
      try {
        await createJulesClient(env).deleteSession(session_id);
        return jsonResult({ success: true, sessionId: session_id });
      } catch {
        return errorResult('Failed to delete Jules session.');
      }
    }
  );

  server.registerTool(
    'list_activities',
    {
      description: 'List activities for a Jules session.',
      inputSchema: {
        session_id: sessionIdSchema,
        page_size: z.number().int().min(1).max(200).default(50),
        page_token: z.string().optional(),
      },
    },
    async ({ session_id, page_size, page_token }) => {
      try {
        const result = await createJulesClient(env).listActivities(
          session_id,
          page_size,
          page_token
        );
        return jsonResult({
          success: true,
          activities: result.activities,
          nextPageToken: result.nextPageToken,
        });
      } catch {
        return errorResult('Failed to list Jules activities.');
      }
    }
  );

  server.registerTool(
    'get_activity',
    {
      description: 'Get one activity from a Jules session.',
      inputSchema: {
        session_id: sessionIdSchema,
        activity_id: activityIdSchema,
      },
    },
    async ({ session_id, activity_id }) => {
      try {
        const activity = await createJulesClient(env).getActivity(
          session_id,
          activity_id
        );
        return jsonResult({ success: true, activity });
      } catch {
        return errorResult('Failed to get Jules activity.');
      }
    }
  );

  server.registerTool(
    'get_activities_since',
    {
      description: 'List Jules session activities newer than an ISO timestamp.',
      inputSchema: getActivitiesSinceSchema,
    },
    async ({ session_id, since, page_size }) => {
      try {
        const result = await createJulesClient(env).listActivitiesSince(
          session_id,
          since,
          page_size
        );
        return jsonResult({
          success: true,
          sessionId: session_id,
          since,
          activities: result.activities,
        });
      } catch {
        return errorResult('Failed to list recent Jules activities.');
      }
    }
  );

  server.registerTool(
    'list_sources',
    {
      description: 'List GitHub repositories connected to Jules.',
      inputSchema: paginationSchema,
    },
    async ({ page_size, page_token }) => {
      try {
        const result = await createJulesClient(env).listSources(
          page_size,
          page_token
        );
        return jsonResult({
          success: true,
          sources: result.sources,
          nextPageToken: result.nextPageToken,
        });
      } catch {
        return errorResult('Failed to list Jules sources.');
      }
    }
  );

  server.registerTool(
    'get_source_details',
    {
      description: 'Get details for a repository source connected to Jules.',
      inputSchema: { source_name: sourceNameSchema },
    },
    async ({ source_name }) => {
      try {
        const source = await createJulesClient(env).getSource(source_name);
        return jsonResult({ success: true, source });
      } catch {
        return errorResult('Failed to get Jules source.');
      }
    }
  );

  return server;
}

/**
 * Validate Cloudflare Access authentication for the privileged MCP endpoint.
 * Managed OAuth runs at Cloudflare Access; this Worker validates the Access JWT.
 * A localhost-only bypass exists solely for `wrangler dev` and is never enabled
 * by the committed production configuration.
 * @param request - Incoming Worker request.
 * @param env - Worker bindings.
 * @returns True when the request is authorized.
 */
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const url = new URL(request.url);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (isLocal && env.LOCAL_DEV_BYPASS_AUTH === 'true') return true;

  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return false;

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return false;

  try {
    const teamDomain = env.TEAM_DOMAIN.replace(/\/$/, '');
    const jwks = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`)
    );
    await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: env.POLICY_AUD,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cloudflare Worker entrypoint.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({
        ok: true,
        service: 'jules-mcp-server-cloudflare',
        version: VERSION,
      });
    }

    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    if (!(await isAuthorized(request, env))) {
      return Response.json(
        { error: 'Unauthorized' },
        {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    if (!env.JULES_API_KEY) {
      return Response.json(
        { error: 'Server is not configured' },
        { status: 503 }
      );
    }

    const handler = createMcpHandler(() => createJulesMcpServer(env), {
      legacy: 'stateless',
    });

    return handler(request, env, ctx as never);
  },
};
