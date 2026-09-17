import type { Activity, ActivityType, ChangeSet } from '../types/jules-api.js';

interface JulesPlanStepDto {
  id?: string;
  index?: number;
  title?: string;
  description?: string;
}

interface JulesPlanDto {
  id?: string;
  steps?: JulesPlanStepDto[];
  createTime?: string;
}

interface JulesGitPatchDto {
  baseCommitId?: string;
  unidiffPatch?: string;
  suggestedCommitMessage?: string;
}

interface JulesArtifactDto {
  changeSet?: {
    source?: string;
    gitPatch?: JulesGitPatchDto;
  };
  bashOutput?: {
    command?: string;
    output?: string;
    exitCode?: number;
  };
  media?: {
    url?: string;
    mimeType?: string;
    data?: string;
    description?: string;
  };
}

/** Raw Activity DTO accepted from the current Jules API plus older shapes we used. */
export interface JulesActivityDto {
  name: string;
  id?: string;
  type?: ActivityType;
  originator?: string;
  description?: string;
  createTime?: string;
  timestamp?: string;
  artifacts?: JulesArtifactDto[];
  planGenerated?: {
    plan?: string | JulesPlanDto;
    changeSet?: ChangeSet;
  };
  planApproved?: {
    planId?: string;
    approvedAt?: string;
  };
  userMessaged?: {
    userMessage?: string;
  };
  messageSent?: {
    prompt?: string;
    sender?: 'USER' | 'AGENT';
  };
  agentMessaged?: {
    agentMessage?: string;
    message?: string;
  };
  progressUpdated?: {
    title?: string;
    description?: string;
    message?: string;
    percentage?: number;
  };
  sessionCompleted?: {
    success?: boolean;
    message?: string;
    pullRequestUrl?: string;
    changeSet?: ChangeSet;
  };
  sessionFailed?: {
    reason?: string;
  };
  media?: {
    url?: string;
    mimeType?: string;
    description?: string;
  };
}

export interface ListActivitiesDto {
  activities?: JulesActivityDto[];
  nextPageToken?: string;
}

function formatPlan(plan: string | JulesPlanDto | undefined): string | undefined {
  if (typeof plan === 'string') return plan;
  if (!plan) return undefined;

  const steps = (plan.steps ?? [])
    .map((step) => {
      const prefix = typeof step.index === 'number' ? `${step.index + 1}. ` : '';
      const title = step.title?.trim();
      const description = step.description?.trim();
      if (title && description) return `${prefix}${title}: ${description}`;
      if (title) return `${prefix}${title}`;
      return description ? `${prefix}${description}` : undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (steps.length > 0) return steps.join('\n');
  return plan.id ? `Plan ${plan.id}` : undefined;
}

function inferActivityType(activity: JulesActivityDto): ActivityType {
  if (activity.type) return activity.type;
  if (activity.planGenerated) return 'PLAN_GENERATED';
  if (activity.planApproved) return 'PLAN_APPROVED';
  if (activity.userMessaged || activity.messageSent) return 'MESSAGE_SENT';
  if (activity.agentMessaged) return 'AGENT_MESSAGED';
  if (activity.progressUpdated) return 'PROGRESS_UPDATED';
  if (activity.sessionCompleted) return 'SESSION_COMPLETED';
  if (activity.sessionFailed) return 'SESSION_FAILED';
  return 'ACTIVITY_TYPE_UNSPECIFIED';
}

function extractChangedFiles(patch: string | undefined): string[] {
  if (!patch) return [];

  const paths: string[] = [];
  const seen = new Set<string>();
  const matcher = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(patch)) !== null) {
    const path = match[2];
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
    if (paths.length >= 100) break;
  }
  return paths;
}

function normalizeArtifactChangeSet(activity: JulesActivityDto): ChangeSet | undefined {
  const raw = activity.artifacts?.find((artifact) => artifact.changeSet)?.changeSet;
  const patch = raw?.gitPatch?.unidiffPatch;
  if (!raw && !patch) return undefined;

  const changedFiles = extractChangedFiles(patch);
  return {
    ...(patch ? { patch } : {}),
    ...(changedFiles.length > 0
      ? { changes: changedFiles.map((path) => ({ path })) }
      : {}),
  };
}

function normalizeProgressMessage(activity: JulesActivityDto): string | undefined {
  const progress = activity.progressUpdated;
  if (!progress) return undefined;
  if (progress.message) return progress.message;
  if (progress.title && progress.description) {
    return `${progress.title}: ${progress.description}`;
  }
  return progress.description ?? progress.title;
}

/**
 * Jules has occasionally surfaced internal-looking channel text inside
 * agentMessaged, for example a value beginning with "闸thought". Do not forward
 * that trace text to MCP consumers. If Jules also includes an explicit final
 * channel marker, preserve only the user-facing text after that marker.
 */
function sanitizeAgentMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;

  const finalMarker = /(?:^|\n)\s*闸final\s*(?:\n|$)/i.exec(message);
  if (finalMarker) {
    const visible = message.slice(finalMarker.index + finalMarker[0].length).trim();
    return visible || undefined;
  }

  if (/^\s*闸(?:thought|analysis)\b/i.test(message)) {
    return undefined;
  }

  return message;
}

/**
 * Convert Jules' current Activity DTO to the stable activity shape consumed by
 * MCP tools. This keeps upstream response changes out of the public MCP contract.
 */
export function normalizeJulesActivity(activity: JulesActivityDto): Activity {
  const type = inferActivityType(activity);
  const artifactChangeSet = normalizeArtifactChangeSet(activity);
  const plan = formatPlan(activity.planGenerated?.plan);
  const progressMessage = normalizeProgressMessage(activity);
  const userMessage = activity.userMessaged?.userMessage;
  const agentMessage = sanitizeAgentMessage(
    activity.agentMessaged?.agentMessage ?? activity.agentMessaged?.message
  );
  const failureReason = activity.sessionFailed?.reason;

  const firstMedia = activity.artifacts?.find((artifact) => artifact.media)?.media;

  const normalized: Activity = {
    name: activity.name,
    type,
    timestamp: activity.createTime ?? activity.timestamp,
  };

  if (activity.planGenerated) {
    normalized.planGenerated = {
      plan: plan ?? activity.description ?? 'Plan generated.',
      changeSet: activity.planGenerated.changeSet ?? artifactChangeSet,
    };
  }

  if (activity.planApproved) {
    normalized.planApproved = {
      approvedAt:
        activity.planApproved.approvedAt ??
        activity.createTime ??
        activity.timestamp ??
        '',
    };
  }

  if (activity.messageSent?.prompt) {
    normalized.messageSent = {
      prompt: activity.messageSent.prompt,
      sender: activity.messageSent.sender ?? 'USER',
    };
  } else if (userMessage) {
    normalized.messageSent = { prompt: userMessage, sender: 'USER' };
  }

  if (agentMessage) {
    normalized.agentMessaged = { message: agentMessage };
  }

  if (progressMessage) {
    normalized.progressUpdated = {
      message: progressMessage,
      percentage: activity.progressUpdated?.percentage,
    };
  } else if (failureReason) {
    normalized.progressUpdated = { message: failureReason };
  } else if (
    activity.description &&
    !activity.planGenerated &&
    !activity.agentMessaged &&
    !activity.userMessaged &&
    !activity.messageSent &&
    !activity.sessionCompleted
  ) {
    // Preserve useful descriptions for activity kinds that do not have a
    // dedicated payload in our normalized model.
    normalized.progressUpdated = { message: activity.description };
  }

  if (activity.sessionCompleted) {
    normalized.sessionCompleted = {
      success: activity.sessionCompleted.success ?? true,
      message: activity.sessionCompleted.message ?? activity.description,
      pullRequestUrl: activity.sessionCompleted.pullRequestUrl,
      changeSet: activity.sessionCompleted.changeSet ?? artifactChangeSet,
    };
  }

  if (activity.media || firstMedia) {
    const media = activity.media ?? firstMedia;
    normalized.media = {
      url: media?.url,
      mimeType: media?.mimeType,
      description: media?.description ?? activity.description,
    };
  }

  return normalized;
}