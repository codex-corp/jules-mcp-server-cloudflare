import type { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';

import { JulesAPIError, JulesClient } from './api/jules-client.js';
import baseWorker, {
  createJulesMcpServer,
  isAuthorized,
  type Env,
} from './worker.js';
import type { Activity } from './types/jules-api.js';

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type ActivityContentType =
  | 'agent_message'
  | 'plan'
  | 'user_message'
  | 'progress_message'
  | 'completion_message'
  | 'failure_reason'
  | 'description';

interface ActivityContent {
  type: ActivityContentType;
  text: string;
}

const DEFAULT_CONTENT_CHUNK_LENGTH = 10000;
const MAX_CONTENT_CHUNK_LENGTH = 20000;

const sessionIdSchema = z
  .string()
  .regex(/^[\w-]+$/, 'Session ID contains invalid characters');

const activityIdSchema = z
  .string()
  .regex(/^[\w-]+$/, 'Activity ID contains invalid characters');

const activityContentTypeSchema = z.enum([
  'agent_message',
  'plan',
  'user_message',
  'progress_message',
  'completion_message',
  'failure_reason',
  'description',
]);

const getActivityContentSchema = {
  session_id: sessionIdSchema,
  activity_id: activityIdSchema,
  offset: z.number().int().min(0).default(0),
  max_chars: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTENT_CHUNK_LENGTH)
    .default(DEFAULT_CONTENT_CHUNK_LENGTH),
};

const toolErrorCodeSchema = z.enum([
  'AUTH_ERROR',
  'NOT_FOUND',
  'RATE_LIMITED',
  'UPSTREAM_TIMEOUT',
  'JULES_UPSTREAM_ERROR',
  'RESPONSE_VALIDATION_ERROR',
]);

const toolErrorSchema = z.object({
  code: toolErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  upstream_status: z.number().int().optional(),
  upstream_code: z.union([z.string(), z.number()]).optional(),
});

const activityContentOutputSchema = z.object({
  success: z.boolean(),
  activityId: z.string().optional(),
  activityType: z.string().optional(),
  timestamp: z.string().optional(),
  contentAvailable: z.boolean().optional(),
  contentType: activityContentTypeSchema.optional(),
  contentChunk: z.string().optional(),
  offset: z.number().int().optional(),
  nextOffset: z.number().int().optional(),
  hasMore: z.boolean().optional(),
  totalChars: z.number().int().optional(),
  error: toolErrorSchema.optional(),
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

function activityId(activity: Activity): string {
  const parts = activity.name.split('/');
  return parts.at(-1) || activity.name;
}

/**
 * Select the primary user-visible text carried by a normalized Jules activity.
 * Agent messages are already sanitized by the activity normalizer before this
 * function sees them.
 */
export function selectActivityContent(
  activity: Activity
): ActivityContent | undefined {
  if (activity.agentMessaged?.message) {
    return { type: 'agent_message', text: activity.agentMessaged.message };
  }

  if (activity.planGenerated?.plan) {
    return { type: 'plan', text: activity.planGenerated.plan };
  }

  if (activity.messageSent?.prompt) {
    return {
      type:
        activity.messageSent.sender === 'AGENT'
          ? 'agent_message'
          : 'user_message',
      text: activity.messageSent.prompt,
    };
  }

  if (activity.failureReason) {
    return { type: 'failure_reason', text: activity.failureReason };
  }

  if (activity.progressUpdated?.message) {
    return { type: 'progress_message', text: activity.progressUpdated.message };
  }

  if (activity.sessionCompleted?.message) {
    return {
      type: 'completion_message',
      text: activity.sessionCompleted.message,
    };
  }

  if (activity.description) {
    return { type: 'description', text: activity.description };
  }

  return undefined;
}

/**
 * Slice activity text by Unicode code points so continuation offsets never split
 * a surrogate pair. Reassembling sequential chunks reproduces the exact text.
 */
export function chunkActivityContent(
  content: string,
  offset: number,
  maxChars: number
) {
  const characters = Array.from(content);
  const safeOffset = Math.min(offset, characters.length);
  const chunk = characters.slice(safeOffset, safeOffset + maxChars).join('');
  const nextOffset = safeOffset + Array.from(chunk).length;
  const hasMore = nextOffset < characters.length;

  return {
    contentChunk: chunk,
    offset: safeOffset,
    nextOffset: hasMore ? nextOffset : undefined,
    hasMore,
    totalChars: characters.length,
  };
}

function extractUpstreamCode(response: unknown): string | number | undefined {
  if (typeof response !== 'string') return undefined;

  try {
    const parsed = JSON.parse(response) as {
      error?: { status?: unknown; code?: unknown };
    };
    const status = parsed.error?.status;
    if (typeof status === 'string' || typeof status === 'number') return status;
    const code = parsed.error?.code;
    if (typeof code === 'string' || typeof code === 'number') return code;
  } catch {
    return undefined;
  }

  return undefined;
}

function classifyToolError(error: unknown, fallbackMessage: string) {
  if (error instanceof JulesAPIError) {
    const upstreamStatus = error.statusCode;
    const upstreamCode = extractUpstreamCode(error.response);
    const message = error.message.toLowerCase();

    let code:
      | 'AUTH_ERROR'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'UPSTREAM_TIMEOUT'
      | 'JULES_UPSTREAM_ERROR';
    let retryable = false;

    if (upstreamStatus === 401 || upstreamStatus === 403) {
      code = 'AUTH_ERROR';
    } else if (upstreamStatus === 404) {
      code = 'NOT_FOUND';
    } else if (upstreamStatus === 429) {
      code = 'RATE_LIMITED';
      retryable = true;
    } else if (
      upstreamStatus === 408 ||
      upstreamStatus === 504 ||
      message.includes('timeout') ||
      message.includes('aborted')
    ) {
      code = 'UPSTREAM_TIMEOUT';
      retryable = true;
    } else {
      code = 'JULES_UPSTREAM_ERROR';
      retryable = upstreamStatus === undefined || upstreamStatus >= 500;
    }

    return {
      code,
      message: fallbackMessage,
      retryable,
      ...(upstreamStatus !== undefined
        ? { upstream_status: upstreamStatus }
        : {}),
      ...(upstreamCode !== undefined ? { upstream_code: upstreamCode } : {}),
    };
  }

  return {
    code: 'RESPONSE_VALIDATION_ERROR' as const,
    message: fallbackMessage,
    retryable: false,
  };
}

function jsonResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(error: unknown, fallbackMessage: string) {
  const value = {
    success: false,
    error: classifyToolError(error, fallbackMessage),
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
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

/**
 * Create the deployed remote server and extend the compact base contract with
 * explicit lossless activity text retrieval.
 */
export function createRemoteJulesMcpServer(env: Env): McpServer {
  const server = createJulesMcpServer(env);

  server.registerTool(
    'get_activity_content',
    {
      description:
        'Get the full user-visible text for one Jules activity in bounded Unicode-safe chunks. Use nextOffset while hasMore is true.',
      inputSchema: getActivityContentSchema,
      outputSchema: activityContentOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ session_id, activity_id, offset, max_chars }) => {
      try {
        const activity = await createJulesClient(env).getActivity(
          session_id,
          activity_id
        );
        const selected = selectActivityContent(activity);

        if (!selected) {
          return jsonResult({
            success: true,
            activityId: activityId(activity),
            activityType: activity.type,
            timestamp: activity.timestamp,
            contentAvailable: false,
            contentChunk: '',
            offset: 0,
            hasMore: false,
            totalChars: 0,
          });
        }

        return jsonResult({
          success: true,
          activityId: activityId(activity),
          activityType: activity.type,
          timestamp: activity.timestamp,
          contentAvailable: true,
          contentType: selected.type,
          ...chunkActivityContent(selected.text, offset, max_chars),
        });
      } catch (error) {
        return errorResult(error, 'Failed to get Jules activity content.');
      }
    }
  );

  return server;
}

export const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/mcp') {
      return baseWorker.fetch(request, env, ctx as never);
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

    const handler = createMcpHandler(() => createRemoteJulesMcpServer(env), {
      legacy: 'stateless',
    });

    return handler(request, env, ctx as never);
  },
};

export default worker;
