import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import { JulesClient } from './api/jules-client.js';
import type { Activity, Session, Source } from './types/jules-api.js';
import { containsSecret } from './utils/secret-detection.js';

export interface Env {
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
const DEFAULT_PAGE_SIZE = 20;

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
  prompt: z
    .string()
    .min(10)
    .max(10000)
    .refine(
      (value) => !containsSecret(value),
      'Prompt contains potential secrets. Please remove them.'
    ),
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
  prompt: z
    .string()
    .min(10)
    .max(10000)
    .refine(
      (value) => !containsSecret(value),
      'Prompt contains potential secrets. Please remove them.'
    ),
  title: z.string().max(200).optional(),
};

const manageSessionSchema = {
  session_id: sessionIdSchema,
  action: z.enum(['approve_plan', 'send_message', 'reject_plan']),
  message: z
    .string()
    .min(1)
    .max(5000)
    .refine(
      (value) => !containsSecret(value),
      'Message contains potential secrets. Please remove them.'
    )
    .optional(),
};

const paginationSchema = {
  page_size: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
  page_token: z.string().optional(),
};

const getActivitiesSinceSchema = {
  session_id: sessionIdSchema,
  since: z.string().datetime({ offset: true }),
  page_size: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
};

const sessionSummaryOutputSchema = z.object({
  name: z.string(),
  id: z.string(),
  title: z.string().optional(),
  state: z.string().optional(),
  source: z.string().optional(),
  branch: z.string().optional(),
  promptPreview: z.string().optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  monitorUrl: z.string(),
});

const sessionDetailsOutputSchema = sessionSummaryOutputSchema.extend({
  prompt: z.string(),
  automationMode: z.string().optional(),
  requirePlanApproval: z.boolean().optional(),
  pullRequests: z.array(
    z.object({
      url: z.string(),
      title: z.string().optional(),
    })
  ),
});

const sourceOutputSchema = z.object({
  name: z.string(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  htmlUrl: z.string().optional(),
  defaultBranch: z.string().optional(),
});

const activitySummaryOutputSchema = z.object({
  name: z.string(),
  id: z.string(),
  type: z.string(),
  timestamp: z.string().optional(),
  summary: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  hasChangeSet: z.boolean(),
  changedFiles: z.array(z.string()),
});

const activityDetailsOutputSchema = activitySummaryOutputSchema.extend({
  plan: z.string().optional(),
  progressPercentage: z.number().optional(),
  messageSender: z.string().optional(),
  media: z
    .object({
      url: z.string().optional(),
      mimeType: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

const createSessionOutputSchema = z.object({
  success: z.boolean(),
  sessionId: z.string(),
  state: z.string().optional(),
  monitorUrl: z.string(),
});

const listSessionsOutputSchema = z.object({
  success: z.boolean(),
  sessions: z.array(sessionSummaryOutputSchema),
  nextPageToken: z.string().optional(),
});

const sessionStatusOutputSchema = z.object({
  success: z.boolean(),
  session: sessionDetailsOutputSchema,
});

const manageSessionOutputSchema = z.object({
  success: z.boolean(),
  action: z.enum(['approve_plan', 'send_message', 'reject_plan']),
  session: sessionDetailsOutputSchema.optional(),
  sessionId: z.string().optional(),
  state: z.string().optional(),
});

const deleteSessionOutputSchema = z.object({
  success: z.boolean(),
  sessionId: z.string(),
});

const listActivitiesOutputSchema = z.object({
  success: z.boolean(),
  activities: z.array(activitySummaryOutputSchema),
  nextPageToken: z.string().optional(),
});

const activityOutputSchema = z.object({
  success: z.boolean(),
  activity: activityDetailsOutputSchema,
});

const activitiesSinceOutputSchema = z.object({
  success: z.boolean(),
  sessionId: z.string(),
  since: z.string(),
  activities: z.array(activitySummaryOutputSchema),
});

const listSourcesOutputSchema = z.object({
  success: z.boolean(),
  sources: z.array(sourceOutputSchema),
  nextPageToken: z.string().optional(),
});

const sourceDetailsOutputSchema = z.object({
  success: z.boolean(),
  source: sourceOutputSchema,
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

const ADDITIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const DESTRUCTIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function summarizeSession(session: Session) {
  return {
    name: session.name || `sessions/${session.id}`,
    id: session.id,
    title: session.title,
    state: session.state,
    source: session.sourceContext?.source,
    branch: session.sourceContext?.githubRepoContext?.startingBranch,
    promptPreview: truncateText(session.prompt, 500),
    createTime: session.createTime,
    updateTime: session.updateTime,
    monitorUrl: session.url || `https://jules.google.com/sessions/${session.id}`,
  };
}

function sessionDetails(session: Session) {
  const pullRequests = (session.outputs ?? [])
    .map((output) => output.pullRequest)
    .filter((pullRequest): pullRequest is NonNullable<typeof pullRequest> => Boolean(pullRequest))
    .map((pullRequest) => ({
      url: pullRequest.url,
      title: pullRequest.title,
    }));

  return {
    ...summarizeSession(session),
    prompt: truncateText(session.prompt, 5000) ?? '',
    automationMode: session.automationMode,
    requirePlanApproval: session.requirePlanApproval,
    pullRequests,
  };
}

function normalizeSource(source: Source) {
  return {
    name: source.name,
    owner: source.githubRepo?.owner,
    repo: source.githubRepo?.repo,
    htmlUrl: source.githubRepo?.htmlUrl,
    defaultBranch: source.githubRepo?.defaultBranch,
  };
}

function activityId(activity: Activity): string {
  const parts = activity.name.split('/');
  return parts.at(-1) || activity.name;
}

function activityChangeSet(activity: Activity) {
  return activity.planGenerated?.changeSet ?? activity.sessionCompleted?.changeSet;
}

function summarizeActivity(activity: Activity) {
  const changeSet = activityChangeSet(activity);
  const changedFiles = (changeSet?.changes ?? [])
    .map((change) => change.path)
    .filter(Boolean)
    .slice(0, 100);

  const summary =
    truncateText(activity.progressUpdated?.message, 1000) ??
    truncateText(activity.agentMessaged?.message, 1000) ??
    truncateText(activity.messageSent?.prompt, 1000) ??
    truncateText(activity.sessionCompleted?.message, 1000) ??
    truncateText(activity.planGenerated?.plan, 1000) ??
    (activity.planApproved ? 'Plan approved.' : undefined);

  return {
    name: activity.name,
    id: activityId(activity),
    type: activity.type,
    timestamp: activity.timestamp,
    summary,
    pullRequestUrl: activity.sessionCompleted?.pullRequestUrl,
    hasChangeSet: Boolean(changeSet),
    changedFiles,
  };
}

function activityDetails(activity: Activity) {
  return {
    ...summarizeActivity(activity),
    plan: truncateText(activity.planGenerated?.plan, 5000),
    progressPercentage: activity.progressUpdated?.percentage,
    messageSender: activity.messageSent?.sender,
    media: activity.media
      ? {
          url: activity.media.url,
          mimeType: activity.media.mimeType,
          description: truncateText(activity.media.description, 1000),
        }
      : undefined,
  };
}

function jsonResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

export function validateRepository(source: string, allowlist?: string): void {
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
      outputSchema: createSessionOutputSchema,
      annotations: ADDITIVE_WRITE_ANNOTATIONS,
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
      outputSchema: createSessionOutputSchema,
      annotations: ADDITIVE_WRITE_ANNOTATIONS,
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
      description:
        'List compact Jules session summaries. Use get_session_status for one session.',
      inputSchema: paginationSchema,
      outputSchema: listSessionsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_size, page_token }) => {
      try {
        const result = await createJulesClient(env).listSessions(
          page_size,
          page_token
        );
        return jsonResult({
          success: true,
          sessions: result.sessions.map(summarizeSession),
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
      description:
        'Get the current state and compact details of one Jules session.',
      inputSchema: { session_id: sessionIdSchema },
      outputSchema: sessionStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ session_id }) => {
      try {
        const session = await createJulesClient(env).getSession(session_id);
        return jsonResult({ success: true, session: sessionDetails(session) });
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
      outputSchema: manageSessionOutputSchema,
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
    },
    async ({ session_id, action, message }) => {
      try {
        const client = createJulesClient(env);
        if (action === 'approve_plan') {
          const session = await client.approvePlan(session_id);
          return jsonResult({
            success: true,
            action,
            session: sessionDetails(session),
          });
        }
        if (action === 'send_message') {
          if (!message) return errorResult('message is required for send_message.');
          const session = await client.sendMessage(session_id, { prompt: message });
          return jsonResult({
            success: true,
            action,
            session: sessionDetails(session),
          });
        }

        await client.rejectPlan(session_id);
        return jsonResult({
          success: true,
          action,
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
      outputSchema: deleteSessionOutputSchema,
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
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
      description:
        'List compact activities for a Jules session without returning large code patches.',
      inputSchema: {
        session_id: sessionIdSchema,
        page_size: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
        page_token: z.string().optional(),
      },
      outputSchema: listActivitiesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
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
          activities: result.activities.map(summarizeActivity),
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
      description:
        'Get one Jules activity with compact details and changed file names, not raw patches.',
      inputSchema: {
        session_id: sessionIdSchema,
        activity_id: activityIdSchema,
      },
      outputSchema: activityOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ session_id, activity_id }) => {
      try {
        const activity = await createJulesClient(env).getActivity(
          session_id,
          activity_id
        );
        return jsonResult({ success: true, activity: activityDetails(activity) });
      } catch {
        return errorResult('Failed to get Jules activity.');
      }
    }
  );

  server.registerTool(
    'get_activities_since',
    {
      description:
        'List compact Jules session activities newer than an ISO timestamp.',
      inputSchema: getActivitiesSinceSchema,
      outputSchema: activitiesSinceOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
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
          activities: result.activities.map(summarizeActivity),
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
      outputSchema: listSourcesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_size, page_token }) => {
      try {
        const result = await createJulesClient(env).listSources(
          page_size,
          page_token
        );
        return jsonResult({
          success: true,
          sources: result.sources.map(normalizeSource),
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
      outputSchema: sourceDetailsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ source_name }) => {
      try {
        const source = await createJulesClient(env).getSource(source_name);
        return jsonResult({ success: true, source: normalizeSource(source) });
      } catch {
        return errorResult('Failed to get Jules source.');
      }
    }
  );

  return server;
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
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

export const worker = {
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

export default worker;
