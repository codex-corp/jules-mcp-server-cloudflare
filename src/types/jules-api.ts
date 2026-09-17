/**
 * Type definitions for Google Jules v1alpha REST API
 * Based on: https://jules.google/docs/api/reference/
 */

/**
 * Represents a normalized source repository consumed by the MCP layer.
 * Raw Jules source DTOs are normalized by JulesClient before they reach callers.
 */
export interface Source {
  /** Opaque Jules resource name in the form sources/{source}. */
  name: string;
  /** Stable source identifier when Jules provides one. */
  id?: string;
  /** GitHub repository details. */
  githubRepo?: {
    /** The owner of the GitHub repository. */
    owner: string;
    /** The name of the GitHub repository. */
    repo: string;
    /** Optional HTML URL retained for compatibility with live Jules responses. */
    htmlUrl?: string;
    /** Whether the repository is private. */
    isPrivate?: boolean;
    /** Normalized default branch name when Jules provides one. */
    defaultBranch?: string;
    /** Normalized active branch names when Jules provides them. */
    branches?: string[];
  };
}

/**
 * Response object for listing sources.
 */
export interface ListSourcesResponse {
  /** A list of source repositories. */
  sources: Source[];
  /** A token for the next page of results. */
  nextPageToken?: string;
}

/**
 * Context for a GitHub repository.
 */
interface GitHubRepoContext {
  /** Branch to base changes on. */
  startingBranch: string;
}

/**
 * Context for a source repository.
 */
export interface SourceContext {
  /** Opaque resource name of the source. */
  source: string;
  /** GitHub repository context details. */
  githubRepoContext?: GitHubRepoContext;
}

/**
 * Automation mode for a session.
 * - `AUTO_CREATE_PR`: Automatically create a pull request.
 * - `AUTOMATION_MODE_UNSPECIFIED`: Unspecified automation mode.
 */
export type AutomationMode =
  | 'AUTO_CREATE_PR'
  | 'AUTOMATION_MODE_UNSPECIFIED';

/**
 * State of a session. Compatibility values are retained for live/legacy API
 * responses even when the current public reference does not list every value.
 */
export type SessionState =
  | 'STATE_UNSPECIFIED'
  | 'SESSION_STATE_UNSPECIFIED'
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED';

/**
 * Represents a Jules session.
 */
export interface Session {
  /** Resource name format: sessions/{id}. */
  name: string;
  /** Unique session identifier. */
  id: string;
  /** Optional human-readable title. */
  title?: string;
  /** Optional monitor URL returned by the Jules API. */
  url?: string;
  /** Source context for the session. */
  sourceContext?: SourceContext;
  /** Natural language task prompt. */
  prompt: string;
  /** Current session state. */
  state?: SessionState;
  /** Automation configuration. */
  automationMode?: AutomationMode;
  /** Whether plan approval is required. */
  requirePlanApproval?: boolean;
  /** Timestamp when created. */
  createTime?: string;
  /** Timestamp when last updated. */
  updateTime?: string;
  /** Session outputs such as generated pull requests. */
  outputs?: {
    /** Pull request created by the session, if available. */
    pullRequest?: {
      /** Pull request URL. */
      url: string;
      /** Optional pull request title. */
      title?: string;
      /** Optional pull request description. */
      description?: string;
    };
  }[];
}

/**
 * Request object for creating a new session.
 */
export interface CreateSessionRequest {
  /** Natural language task prompt. */
  prompt: string;
  /** Source context for the session. */
  sourceContext?: SourceContext;
  /** Optional human-readable title. */
  title?: string;
  /** Automation configuration. */
  automationMode?: AutomationMode;
  /** Whether plan approval is required. */
  requirePlanApproval?: boolean;
}

/**
 * Response object for listing sessions.
 */
export interface ListSessionsResponse {
  /** A list of sessions. */
  sessions: Session[];
  /** A token for the next page of results. */
  nextPageToken?: string;
}

/**
 * Normalized activity type used by callers after JulesClient maps the upstream DTO.
 */
export type ActivityType =
  | 'PLAN_GENERATED'
  | 'PROGRESS_UPDATED'
  | 'SESSION_COMPLETED'
  | 'SESSION_FAILED'
  | 'MESSAGE_SENT'
  | 'AGENT_MESSAGED'
  | 'PLAN_APPROVED'
  | 'ACTIVITY_TYPE_UNSPECIFIED';

/**
 * Represents a set of code changes.
 */
export interface ChangeSet {
  /** Source resource the changes apply to. */
  source?: string;
  /** Commit the patch should be applied to. */
  baseCommitId?: string;
  /** Suggested commit message from Jules. */
  suggestedCommitMessage?: string;
  /** Unified patch for the full change set. Kept internal to explicit patch tools. */
  patch?: string;
  /** Array of file changes. */
  changes?: {
    /** The path of the file changed. */
    path: string;
    /** The diff of the changes. */
    diff?: string;
    /** The old content of the file. */
    oldContent?: string;
    /** The new content of the file. */
    newContent?: string;
  }[];
}

/**
 * Normalized bash artifact retained for explicit artifact inspection tools.
 */
export interface BashOutputArtifact {
  /** Command that Jules executed. */
  command?: string;
  /** Combined stdout/stderr. Kept internal to bounded artifact output. */
  output?: string;
  /** Process exit code. */
  exitCode?: number;
}

/**
 * Normalized media artifact metadata. Base64 data is intentionally never retained.
 */
export interface MediaArtifact {
  /** Optional remote media URL. */
  url?: string;
  /** Media MIME type. */
  mimeType?: string;
  /** Optional human-readable description. */
  description?: string;
  /** Whether the upstream artifact included embedded data. */
  dataAvailable?: boolean;
}

/**
 * Artifact collection attached to a normalized activity.
 */
export interface ActivityArtifacts {
  /** Code change artifacts. */
  changeSets: ChangeSet[];
  /** Bash command outputs. */
  bashOutputs: BashOutputArtifact[];
  /** Media metadata without base64 payloads. */
  media: MediaArtifact[];
}

/**
 * Normalized activity consumed by local tools and the Worker adapter.
 * JulesClient converts the current upstream Activity DTO into this stable shape.
 */
export interface Activity {
  /** Resource name format: sessions/{session_id}/activities/{activity_id}. */
  name: string;
  /** Activity type. */
  type: ActivityType;
  /** Entity that created the activity when Jules provides it. */
  originator?: string;
  /** Human-readable upstream description. */
  description?: string;
  /** Timestamp when activity occurred. */
  timestamp?: string;
  /** Failure reason for SESSION_FAILED activities. */
  failureReason?: string;
  /** Normalized activity artifacts for explicit detail tools. */
  artifacts?: ActivityArtifacts;
  /** Activity-specific payload. */
  planGenerated?: {
    /** The generated plan description. */
    plan: string;
    /** Plan identifier when Jules provides one. */
    planId?: string;
    /** The set of changes proposed in the plan. */
    changeSet?: ChangeSet;
  };
  progressUpdated?: {
    /** The progress message. */
    message: string;
    /** The completion percentage. */
    percentage?: number;
  };
  sessionCompleted?: {
    /** Whether the session completed successfully. */
    success: boolean;
    /** A message describing the completion. */
    message?: string;
    /** The URL of the created pull request, if any. */
    pullRequestUrl?: string;
    /** The final set of changes for the session, if available. */
    changeSet?: ChangeSet;
  };
  messageSent?: {
    /** The message content. */
    prompt: string;
    /** The sender of the message. */
    sender: 'USER' | 'AGENT';
  };
  planApproved?: {
    /** ID of the approved plan. */
    planId?: string;
    /** When the plan was approved, if known. */
    approvedAt?: string;
  };
  agentMessaged?: {
    /** Agent-authored message requiring user attention. */
    message: string;
  };
  media?: {
    /** Optional media URL. */
    url?: string;
    /** Media MIME type. */
    mimeType?: string;
    /** Optional human-readable description. */
    description?: string;
  };
}

/**
 * Response object for listing activities.
 */
export interface ListActivitiesResponse {
  /** A list of activities. */
  activities: Activity[];
  /** A token for the next upstream page of results. */
  nextPageToken?: string;
  /** Whether a bounded incremental activity result has additional items. */
  hasMore?: boolean;
  /** Opaque continuation cursor for a bounded incremental activity result. */
  nextCursor?: string;
}

/**
 * Request object for sending a message.
 */
export interface SendMessageRequest {
  /** The message content to send. */
  prompt: string;
}
