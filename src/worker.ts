import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import { JulesAPIError, JulesClient } from './api/jules-client.js';
import type { Activity, ChangeSet, Session, Source } from './types/jules-api.js';
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
const MAX_SESSION_TITLE_LENGTH = 160;
const MAX_SESSION_PROMPT_LENGTH = 4000;
const MAX_ACTIVITY_SUMMARY_LENGTH = 500;
const MAX_ACTIVITY_PLAN_LENGTH = 4000;
const MAX_ACTIVITY_DESCRIPTION_LENGTH = 1000;
const MAX_MEDIA_DESCRIPTION_LENGTH = 500;
const MAX_PULL_REQUESTS = 20;
const MAX_CHANGED_FILES = 50;
const MAX_SOURCE_BRANCHES = 100;
const MAX_ARTIFACTS = 50;
const MAX_BASH_COMMAND_LENGTH = 500;
const MAX_BASH_OUTPUT_PREVIEW_LENGTH = 2000;
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const DEFAULT_PATCH_CHUNK_LENGTH = 10000;
const MAX_PATCH_CHUNK_LENGTH = 20000;

const sessionIdSchema = z
  .string()
  .regex(/^[\w-]+$/, 'Session ID contains invalid characters');

const sourceNameSchema = z
  .string()
  .min(9)
  .max(512)
  .refine(
    (value) =>
      value.startsWith('sources/') &&
      value.length > 'sources/'.length &&
      !value.includes('?') &&
      !value.includes('#'),
    'Source must be a Jules resource name beginning with sources/'
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
  action: z.enum(['approve_plan', 'send_message']),
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
  page_size: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  page_token: z.string().optional(),
};

const getActivitiesSinceSchema = {
  session_id: sessionIdSchema,
  since: z.string().datetime({ offset: true }),
  page_size: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(1000).optional(),
};

const getActivityPatchSchema = {
  session_id: sessionIdSchema,
  activity_id: activityIdSchema,
  change_set_index: z.number().int().min(0).max(999).default(0),
  offset: z.number().int().min(0).default(0),
  max_chars: z
    .number()
    .int()
    .min(1)
    .max(MAX_PATCH_CHUNK_LENGTH)
    .default(DEFAULT_PATCH_CHUNK_LENGTH),
};

const sessionListItemOutputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  state: z.string().optional(),
  source: z.string().optional(),
  branch: z.string().optional(),
  updateTime: z.string().optional(),
});

const sessionStatusValueOutputSchema = z.object({
  id: z.string(),
  state: z.string().optional(),
  updateTime: z.string().optional(),
  monitorUrl: z.string(),
});

const sessionDetailsOutputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  state: z.string().optional(),
  source: z.string().optional(),
  branch: z.string().optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  monitorUrl: z.string(),
  prompt: z.string(),
  promptTruncated: z.boolean(),
  automationMode: z.string().optional(),
  requirePlanApproval: z.boolean().optional(),
  pullRequests: z.array(
    z.object({
      url: z.string(),
      title: z.string().optional(),
    })
  ),
});

const sourceSummaryOutputSchema = z.object({
  name: z.string(),
  id: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  htmlUrl: z.string().optional(),
  isPrivate: z.boolean().optional(),
  defaultBranch: z.string().optional(),
});

const sourceDetailsValueOutputSchema = sourceSummaryOutputSchema.extend({
  branches: z.array(z.string()),
  branchesTruncated: z.boolean(),
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

const artifactCountsOutputSchema = z.object({
  changeSets: z.number().int(),
  bashOutputs: z.number().int(),
  media: z.number().int(),
});

const activityDetailsOutputSchema = activitySummaryOutputSchema.extend({
  originator: z.string().optional(),
  description: z.string().optional(),
  failureReason: z.string().optional(),
  planId: z.string().optional(),
  plan: z.string().optional(),
  progressPercentage: z.number().optional(),
  messageSender: z.string().optional(),
  hasArtifacts: z.boolean(),
  artifactCounts: artifactCountsOutputSchema,
  media: z
    .object({
      url: z.string().optional(),
      mimeType: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

const changeSetArtifactOutputSchema = z.object({
  index: z.number().int(),
  source: z.string().optional(),
  baseCommitId: z.string().optional(),
  suggestedCommitMessage: z.string().optional(),
  changedFiles: z.array(z.string()),
  patchAvailable: z.boolean(),
  patchChars: z.number().int(),
});

const bashArtifactOutputSchema = z.object({
  index: z.number().int(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  outputPreview: z.string().optional(),
  outputTruncated: z.boolean(),
  outputChars: z.number().int(),
});

const mediaArtifactOutputSchema = z.object({
  index: z.number().int(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  description: z.string().optional(),
  dataAvailable: z.boolean(),
});

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

const createSessionOutputSchema = z.object({
  success: z.boolean(),
  sessionId: z.string().optional(),
  state: z.string().optional(),
  monitorUrl: z.string().optional(),
  error: toolErrorSchema.optional(),
});

const listSessionsOutputSchema = z.object({
  success: z.boolean(),
  sessions: z.array(sessionListItemOutputSchema).optional(),
  nextPageToken: z.string().optional(),
  error: toolErrorSchema.optional(),
});

const sessionStatusOutputSchema = z.object({
  success: z.boolean(),
  session: sessionStatusValueOutputSchema.optional(),
  error: toolErrorSchema.optional(),
});

const sessionDetailsToolOutputSchema = z.object({
  success: z.boolean(),
  session: sessionDetailsOutputSchema.optional(),
  error: toolErrorSchema.optional(),
});

const manageSessionOutputSchema = z.object({
  success: z.boolean(),
  action: z.enum(['approve_plan', 'send_message']).optional(),
  session: sessionStatusValueOutputSchema.optional(),
  sessionId: z.string().optional(),
  state: z.string().optional(),
  error: toolErrorSchema.optional(),
});

const deleteSessionOutputSchema = z.object({
  success: z.boolean(),
  sessionId: z.string().optional(),
  error: toolErrorSchema.optional(),
});

const listActivitiesOutputSchema = z.object({
  success: z.boolean(),
  activities: z.array(activitySummaryOutputSchema).optional(),
  nextPageToken: z.string().optional(),
  error: toolErrorSchema.optional(),
});

const activityOutputSchema = z.object({
  success: z.boolean(),
  activity: activityDetailsOutputSchema.optional(),
  error: toolErrorSchema.optional(),
});

const activityArtifactsOutputSchema = z.object({
  success: z.boolean(),
  activityId: z.string().optional(),
  artifacts: z
    .object({
      changeSets: z.array(changeSetArtifactOutputSchema),
      bashOutputs: z.array(bashArtifactOutputSchema),
      media: z.array(mediaArtifactOutputSchema),
      truncated: z.boolean(),
    })
    .optional(),
  error: toolErrorSchema.optional(),
});

const activityPatchOutputSchema = z.object({
  success: z.boolean(),
  activityId: z.string().optional(),
  changeSetIndex: z.number().int().optional(),
  source: z.string().optional(),
  baseCommitId: z.string().optional(),
  suggestedCommitMessage: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  patchChunk: z.string().optional(),
  offset: z.number().int().optional(),
  nextOffset: z.number().int().optional(),
  hasMore: z.boolean().optional(),
  totalChars: z.number().int().optional(),
  error: toolErrorSchema.optional(),
});

const activitiesSinceOutputSchema = z.object({
  success: z.boolean(),
  sessionId: z.string().optional(),
  since: z.string().optional(),
  activities: z.array(activitySummaryOutputSchema).optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
  error: toolErrorSchema.optional(),
});

const listSourcesOutputSchema = z.object({
  success: z.boolean(),
  sources: z.array(sourceSummaryOutputSchema).optional(),
  nextPageToken: z.string().optional(),
  error: toolErrorSchema.optional(),
});

const sourceDetailsOutputSchema = z.object({
  success: z.boolean(),
  source: sourceDetailsValueOutputSchema.optional(),
  error: toolErrorSchema.optional(),
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

function truncateText(
  value: string | undefined,
  maxLength: number
): string | undefined {
  if (!value) return value;
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return '…'.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}

function sessionMonitorUrl(session: Session): string {
  return session.url || `https://jules.google.com/sessions/${session.id}`;
}

function sessionListItem(session: Session) {
  return {
    id: session.id,
    title: truncateText(session.title, MAX_SESSION_TITLE_LENGTH),
    state: session.state,
    source: session.sourceContext?.source,
    branch: session.sourceContext?.githubRepoContext?.startingBranch,
    updateTime: session.updateTime,
  };
}

function sessionStatus(session: Session) {
  return {
    id: session.id,
    state: session.state,
    updateTime: session.updateTime,
    monitorUrl: sessionMonitorUrl(session),
  };
}

function sessionDetails(session: Session) {
  const prompt = session.prompt ?? '';
  const pullRequests = (session.outputs ?? [])
    .map((output) => output.pullRequest)
    .filter(
      (pullRequest): pullRequest is NonNullable<typeof pullRequest> =>
        Boolean(pullRequest)
    )
    .slice(0, MAX_PULL_REQUESTS)
    .map((pullRequest) => ({
      url: pullRequest.url,
      title: truncateText(pullRequest.title, MAX_SESSION_TITLE_LENGTH),
    }));

  return {
    id: session.id,
    title: truncateText(session.title, MAX_SESSION_TITLE_LENGTH),
    state: session.state,
    source: session.sourceContext?.source,
    branch: session.sourceContext?.githubRepoContext?.startingBranch,
    createTime: session.createTime,
    updateTime: session.updateTime,
    monitorUrl: sessionMonitorUrl(session),
    prompt: truncateText(prompt, MAX_SESSION_PROMPT_LENGTH) ?? '',
    promptTruncated: prompt.length > MAX_SESSION_PROMPT_LENGTH,
    automationMode: session.automationMode,
    requirePlanApproval: session.requirePlanApproval,
    pullRequests,
  };
}

function sourceSummary(source: Source) {
  return {
    name: source.name,
    id: source.id,
    owner: source.githubRepo?.owner,
    repo: source.githubRepo?.repo,
    htmlUrl: source.githubRepo?.htmlUrl,
    isPrivate: source.githubRepo?.isPrivate,
    defaultBranch: source.githubRepo?.defaultBranch,
  };
}

function sourceDetails(source: Source) {
  const branches = source.githubRepo?.branches ?? [];
  return {
    ...sourceSummary(source),
    branches: branches.slice(0, MAX_SOURCE_BRANCHES),
    branchesTruncated: branches.length > MAX_SOURCE_BRANCHES,
  };
}

function activityId(activity: Activity): string {
  const parts = activity.name.split('/');
  return parts.at(-1) || activity.name;
}

function activityChangeSet(activity: Activity) {
  return (
    activity.planGenerated?.changeSet ??
    activity.sessionCompleted?.changeSet ??
    activity.artifacts?.changeSets[0]
  );
}

function changedFilesFor(changeSet: ChangeSet | undefined) {
  return (changeSet?.changes ?? [])
    .map((change) => change.path)
    .filter(Boolean)
    .slice(0, MAX_CHANGED_FILES);
}

function summarizeActivity(activity: Activity) {
  const changeSet = activityChangeSet(activity);
  const changedFiles = changedFilesFor(changeSet);

  const summary =
    truncateText(
      activity.progressUpdated?.message,
      MAX_ACTIVITY_SUMMARY_LENGTH
    ) ??
    truncateText(
      activity.agentMessaged?.message,
      MAX_ACTIVITY_SUMMARY_LENGTH
    ) ??
    truncateText(activity.messageSent?.prompt, MAX_ACTIVITY_SUMMARY_LENGTH) ??
    truncateText(
      activity.sessionCompleted?.message,
      MAX_ACTIVITY_SUMMARY_LENGTH
    ) ??
    truncateText(activity.planGenerated?.plan, MAX_ACTIVITY_SUMMARY_LENGTH) ??
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

function artifactCounts(activity: Activity) {
  return {
    changeSets: activity.artifacts?.changeSets.length ?? 0,
    bashOutputs: activity.artifacts?.bashOutputs.length ?? 0,
    media: activity.artifacts?.media.length ?? 0,
  };
}

function activityDetails(activity: Activity) {
  const counts = artifactCounts(activity);
  return {
    ...summarizeActivity(activity),
    originator: activity.originator,
    description: truncateText(
      activity.description,
      MAX_ACTIVITY_DESCRIPTION_LENGTH
    ),
    failureReason: truncateText(
      activity.failureReason,
      MAX_ACTIVITY_DESCRIPTION_LENGTH
    ),
    planId: activity.planApproved?.planId ?? activity.planGenerated?.planId,
    plan: truncateText(activity.planGenerated?.plan, MAX_ACTIVITY_PLAN_LENGTH),
    progressPercentage: activity.progressUpdated?.percentage,
    messageSender: activity.messageSent?.sender,
    hasArtifacts:
      counts.changeSets > 0 || counts.bashOutputs > 0 || counts.media > 0,
    artifactCounts: counts,
    media: activity.media
      ? {
          url: activity.media.url,
          mimeType: activity.media.mimeType,
          description: truncateText(
            activity.media.description,
            MAX_MEDIA_DESCRIPTION_LENGTH
          ),
        }
      : undefined,
  };
}

function activityArtifacts(activity: Activity) {
  const changeSets = (activity.artifacts?.changeSets ?? [])
    .slice(0, MAX_ARTIFACTS)
    .map((changeSet, index) => ({
      index,
      source: changeSet.source,
      baseCommitId: changeSet.baseCommitId,
      suggestedCommitMessage: truncateText(
        changeSet.suggestedCommitMessage,
        MAX_COMMIT_MESSAGE_LENGTH
      ),
      changedFiles: changedFilesFor(changeSet),
      patchAvailable: Boolean(changeSet.patch),
      patchChars: changeSet.patch?.length ?? 0,
    }));

  const bashOutputs = (activity.artifacts?.bashOutputs ?? [])
    .slice(0, MAX_ARTIFACTS)
    .map((bashOutput, index) => {
      const output = bashOutput.output ?? '';
      return {
        index,
        command: truncateText(bashOutput.command, MAX_BASH_COMMAND_LENGTH),
        exitCode: bashOutput.exitCode,
        outputPreview: truncateText(output, MAX_BASH_OUTPUT_PREVIEW_LENGTH),
        outputTruncated: output.length > MAX_BASH_OUTPUT_PREVIEW_LENGTH,
        outputChars: output.length,
      };
    });

  const media = (activity.artifacts?.media ?? [])
    .slice(0, MAX_ARTIFACTS)
    .map((artifact, index) => ({
      index,
      url: artifact.url,
      mimeType: artifact.mimeType,
      description: truncateText(
        artifact.description,
        MAX_MEDIA_DESCRIPTION_LENGTH
      ),
      dataAvailable: Boolean(artifact.dataAvailable),
    }));

  const artifacts = activity.artifacts;
  const truncated = Boolean(
    artifacts &&
      (artifacts.changeSets.length > MAX_ARTIFACTS ||
        artifacts.bashOutputs.length > MAX_ARTIFACTS ||
        artifacts.media.length > MAX_ARTIFACTS)
  );

  return { changeSets, bashOutputs, media, truncated };
}

function activityPatch(
  activity: Activity,
  changeSetIndex: number,
  offset: number,
  maxChars: number
) {
  const changeSet = activity.artifacts?.changeSets[changeSetIndex];
  if (!changeSet) {
    throw new JulesAPIError('Activity change set not found.', 404);
  }

  const patch = changeSet.patch ?? '';
  const safeOffset = Math.min(offset, patch.length);
  const patchChunk = patch.slice(safeOffset, safeOffset + maxChars);
  const nextOffset = safeOffset + patchChunk.length;
  const hasMore = nextOffset < patch.length;

  return {
    success: true,
    activityId: activityId(activity),
    changeSetIndex,
    source: changeSet.source,
    baseCommitId: changeSet.baseCommitId,
    suggestedCommitMessage: truncateText(
      changeSet.suggestedCommitMessage,
      MAX_COMMIT_MESSAGE_LENGTH
    ),
    changedFiles: changedFilesFor(changeSet),
    patchChunk,
    offset: safeOffset,
    nextOffset: hasMore ? nextOffset : undefined,
    hasMore,
    totalChars: patch.length,
  };
}

function jsonResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
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
  if (
    error instanceof Error &&
    error.message === 'Repository is not authorized for this MCP server.'
  ) {
    return {
      code: 'AUTH_ERROR' as const,
      message: fallbackMessage,
      retryable: false,
    };
  }

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

function hasRepositoryAllowlist(allowlist?: string): boolean {
  return Boolean(
    allowlist
      ?.split(',')
      .map((repo) => repo.trim())
      .some(Boolean)
  );
}

export function validateRepository(source: Source, allowlist?: string): void {
  if (!hasRepositoryAllowlist(allowlist)) return;

  const repository = source.githubRepo;
  if (!repository?.owner || !repository.repo) {
    throw new Error('Repository is not authorized for this MCP server.');
  }

  const allowed = (allowlist ?? '')
    .split(',')
    .map((repo) => repo.trim().toLowerCase())
    .filter(Boolean);
  const resolvedRepository = `${repository.owner}/${repository.repo}`.toLowerCase();

  if (!allowed.includes(resolvedRepository)) {
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
        const client = createJulesClient(env);
        if (hasRepositoryAllowlist(env.JULES_ALLOWED_REPOS)) {
          const resolvedSource = await client.getSource(args.source);
          validateRepository(resolvedSource, env.JULES_ALLOWED_REPOS);
        }

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
          monitorUrl: sessionMonitorUrl(session),
        });
      } catch (error) {
        return errorResult(error, 'Failed to create Jules coding session.');
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
          monitorUrl: sessionMonitorUrl(session),
        });
      } catch (error) {
        return errorResult(error, 'Failed to create Jules session.');
      }
    }
  );

  server.registerTool(
    'list_sessions',
    {
      description:
        'List bounded Jules session summaries without prompts. Use get_session_status for polling and get_session_details only when task context is needed.',
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
          sessions: result.sessions.map(sessionListItem),
          nextPageToken: result.nextPageToken,
        });
      } catch (error) {
        return errorResult(error, 'Failed to list Jules sessions.');
      }
    }
  );

  server.registerTool(
    'get_session_status',
    {
      description:
        'Get polling-safe Jules session status only. This tool does not return the prompt or large session metadata.',
      inputSchema: { session_id: sessionIdSchema },
      outputSchema: sessionStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ session_id }) => {
      try {
        const session = await createJulesClient(env).getSession(session_id);
        return jsonResult({ success: true, session: sessionStatus(session) });
      } catch (error) {
        return errorResult(error, 'Failed to get Jules session.');
      }
    }
  );

  server.registerTool(
    'get_session_details',
    {
      description:
        'Get bounded Jules session details including prompt, configuration, and pull request metadata. Use only when those details are needed.',
      inputSchema: { session_id: sessionIdSchema },
      outputSchema: sessionDetailsToolOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ session_id }) => {
      try {
        const session = await createJulesClient(env).getSession(session_id);
        return jsonResult({ success: true, session: sessionDetails(session) });
      } catch (error) {
        return errorResult(error, 'Failed to get Jules session details.');
      }
    }
  );

  server.registerTool(
    'manage_session',
    {
      description: 'Approve a Jules plan or send a message to a session.',
      inputSchema: manageSessionSchema,
      outputSchema: manageSessionOutputSchema,
      annotations: ADDITIVE_WRITE_ANNOTATIONS,
    },
    async ({ session_id, action, message }) => {
      try {
        const client = createJulesClient(env);
        if (action === 'approve_plan') {
          const session = await client.approvePlan(session_id);
          return jsonResult({
            success: true,
            action,
            session: sessionStatus(session),
          });
        }

        if (!message) {
          return errorResult(
            new Error('message is required for send_message.'),
            'message is required for send_message.'
          );
        }

        const session = await client.sendMessage(session_id, { prompt: message });
        return jsonResult({
          success: true,
          action,
          session: sessionStatus(session),
        });
      } catch (error) {
        return errorResult(error, 'Failed to manage Jules session.');
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
      } catch (error) {
        return errorResult(error, 'Failed to delete Jules session.');
      }
    }
  );

  server.registerTool(
    'list_activities',
    {
      description:
        'List compact activities for a Jules session without returning large code patches or artifact payloads.',
      inputSchema: {
        session_id: sessionIdSchema,
        page_size: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
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
      } catch (error) {
        return errorResult(error, 'Failed to list Jules activities.');
      }
    }
  );

  server.registerTool(
    'get_activity',
    {
      description:
        'Get one Jules activity with bounded details and artifact counts, not raw patches or full command output.',
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
      } catch (error) {
        return errorResult(error, 'Failed to get Jules activity.');
      }
    }
  );

  server.registerTool(
    'get_activity_artifacts',
    {
      description:
        'Get bounded metadata for one activity artifact set, including changed files and command-output previews but not raw patches or embedded media bytes.',
      inputSchema: {
        session_id: sessionIdSchema,
        activity_id: activityIdSchema,
      },
      outputSchema: activityArtifactsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ session_id, activity_id }) => {
      try {
        const activity = await createJulesClient(env).getActivity(
          session_id,
          activity_id
        );
        return jsonResult({
          success: true,
          activityId: activityId(activity),
          artifacts: activityArtifacts(activity),
        });
      } catch (error) {
        return errorResult(error, 'Failed to get Jules activity artifacts.');
      }
    }
  );

  server.registerTool(
    'get_activity_patch',
    {
      description:
        'Get an explicit bounded chunk of one activity code patch. Continue with nextOffset while hasMore is true.',
      inputSchema: getActivityPatchSchema,
      outputSchema: activityPatchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      session_id,
      activity_id,
      change_set_index,
      offset,
      max_chars,
    }) => {
      try {
        const activity = await createJulesClient(env).getActivity(
          session_id,
          activity_id
        );
        return jsonResult(
          activityPatch(activity, change_set_index, offset, max_chars)
        );
      } catch (error) {
        return errorResult(error, 'Failed to get Jules activity patch.');
      }
    }
  );

  server.registerTool(
    'get_activities_since',
    {
      description:
        'List compact Jules session activities newer than an ISO timestamp, with an opaque cursor when more results remain.',
      inputSchema: getActivitiesSinceSchema,
      outputSchema: activitiesSinceOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ session_id, since, page_size, cursor }) => {
      try {
        const result = await createJulesClient(env).listActivitiesSince(
          session_id,
          since,
          page_size,
          cursor
        );
        return jsonResult({
          success: true,
          sessionId: session_id,
          since,
          activities: result.activities.map(summarizeActivity),
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        });
      } catch (error) {
        return errorResult(error, 'Failed to list recent Jules activities.');
      }
    }
  );

  server.registerTool(
    'list_sources',
    {
      description:
        'List compact GitHub repository sources connected to Jules. Use get_source_details for branches.',
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
          sources: result.sources.map(sourceSummary),
          nextPageToken: result.nextPageToken,
        });
      } catch (error) {
        return errorResult(error, 'Failed to list Jules sources.');
      }
    }
  );

  server.registerTool(
    'get_source_details',
    {
      description:
        'Get repository identity, privacy, default branch, and bounded active branch names for a Jules source.',
      inputSchema: { source_name: sourceNameSchema },
      outputSchema: sourceDetailsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ source_name }) => {
      try {
        const source = await createJulesClient(env).getSource(source_name);
        return jsonResult({ success: true, source: sourceDetails(source) });
      } catch (error) {
        return errorResult(error, 'Failed to get Jules source.');
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
