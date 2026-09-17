/**
 * Jules API Client - Abstraction layer for Google Jules REST API
 * Handles authentication, rate limiting, and type-safe API calls
 */

import type {
  Activity,
  Source,
  ListSourcesResponse,
  Session,
  CreateSessionRequest,
  ListSessionsResponse,
  ListActivitiesResponse,
  SendMessageRequest,
} from '../types/jules-api.js';
import { containsSecret } from '../utils/secret-detection.js';
import {
  normalizeJulesActivity,
  type JulesActivityDto,
  type ListActivitiesDto,
} from './jules-activity-normalizer.js';

/**
 * Runtime configuration for the Jules API client.
 */
export interface JulesClientOptions {
  /** Jules API key. Worker callers should pass this explicitly from a secret binding. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Number of retries after the initial request. */
  maxRetries?: number;
}

type JulesDefaultBranchDto =
  | string
  | { name?: string }
  | null
  | undefined;

/**
 * Raw source DTO returned by Jules. The default branch has appeared in both
 * string and object form, so normalize it before exposing it to the MCP layer.
 */
interface JulesSourceDto {
  name: string;
  githubRepo?: {
    owner: string;
    repo: string;
    htmlUrl: string;
    defaultBranch?: JulesDefaultBranchDto;
  };
}

interface ListSourcesDto {
  sources: JulesSourceDto[];
  nextPageToken?: string;
}

function normalizeDefaultBranch(
  value: JulesDefaultBranchDto
): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.name === 'string') {
    return value.name;
  }
  return undefined;
}

function normalizeSourceDto(source: JulesSourceDto): Source {
  if (!source.githubRepo) {
    return { name: source.name };
  }

  const defaultBranch = normalizeDefaultBranch(source.githubRepo.defaultBranch);
  return {
    name: source.name,
    githubRepo: {
      owner: source.githubRepo.owner,
      repo: source.githubRepo.repo,
      htmlUrl: source.githubRepo.htmlUrl,
      ...(defaultBranch ? { defaultBranch } : {}),
    },
  };
}

function parseDiagnosticPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function extractUpstreamCode(value: unknown): string | number | undefined {
  const parsed = parseDiagnosticPayload(value);
  if (!parsed || typeof parsed !== 'object') return undefined;

  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'string' || typeof status === 'number') return status;

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number'
    ? code
    : undefined;
}

function safeDiagnosticText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserializable diagnostic payload]';
  }

  const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  if (containsSecret(preview)) {
    return '[redacted: potential secret detected]';
  }
  return preview;
}

/**
 * Custom error class for Jules API interactions.
 */
export class JulesAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'JulesAPIError';
  }
}

/**
 * Client for interacting with the Google Jules REST API.
 */
export class JulesClient {
  private readonly baseURL = 'https://jules.googleapis.com/v1alpha';
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(apiKeyOrOptions?: string | JulesClientOptions) {
    const nodeEnv =
      typeof process !== 'undefined' ? process.env : undefined;
    const options: JulesClientOptions =
      typeof apiKeyOrOptions === 'string'
        ? { apiKey: apiKeyOrOptions }
        : (apiKeyOrOptions ?? {});

    this.apiKey = options.apiKey || nodeEnv?.JULES_API_KEY || '';
    if (!this.apiKey) {
      throw new Error(
        'JULES_API_KEY is required. Generate a key at https://jules.google/settings'
      );
    }

    this.timeoutMs =
      options.timeoutMs ?? Number(nodeEnv?.JULES_API_TIMEOUT_MS || 15000);
    this.maxRetries =
      options.maxRetries ?? Number(nodeEnv?.JULES_API_MAX_RETRIES || 2);
  }

  private buildQuery(params: Record<string, string | number | undefined>): string {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    }

    const query = searchParams.toString();
    return query ? `?${query}` : '';
  }

  /**
   * Logs enough activity API context to diagnose a failed live request without
   * logging credentials, headers, request bodies, or opaque page-token values.
   */
  private logActivityFailure(
    operation: string,
    endpoint: string,
    context: Record<string, string | number | boolean | undefined>,
    error: unknown
  ): void {
    const apiError = error instanceof JulesAPIError ? error : undefined;
    console.error('[jules-mcp] Jules activity request failed', {
      operation,
      endpoint,
      status: apiError?.statusCode,
      upstreamCode: extractUpstreamCode(apiError?.response),
      message: safeDiagnosticText(
        error instanceof Error ? error.message : error
      ),
      responsePreview: safeDiagnosticText(apiError?.response),
      ...context,
    });
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'X-Goog-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const rawErrorBody = await response.text();
          const errorBody =
            rawErrorBody.length > 500
              ? rawErrorBody.substring(0, 500) + '... [truncated]'
              : rawErrorBody;

          if (response.status >= 500 && attempt < this.maxRetries) {
            attempt++;
            lastError = new JulesAPIError(
              `Jules API error: ${response.statusText}`,
              response.status,
              errorBody
            );
            continue;
          }
          throw new JulesAPIError(
            `Jules API error: ${response.statusText}`,
            response.status,
            errorBody
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof JulesAPIError) {
          throw error;
        }

        const isAbort =
          error instanceof Error && error.name === 'AbortError';
        if ((isAbort || error instanceof Error) && attempt < this.maxRetries) {
          attempt++;
          lastError = error;
          continue;
        }
        throw new JulesAPIError(
          `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    throw new JulesAPIError(
      `Network error after ${this.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : 'Unknown error'
      }`
    );
  }

  private async requestEmpty(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'X-Goog-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const rawErrorBody = await response.text();
          const errorBody =
            rawErrorBody.length > 500
              ? rawErrorBody.substring(0, 500) + '... [truncated]'
              : rawErrorBody;

          if (response.status >= 500 && attempt < this.maxRetries) {
            attempt++;
            lastError = new JulesAPIError(
              `Jules API error: ${response.statusText}`,
              response.status,
              errorBody
            );
            continue;
          }
          throw new JulesAPIError(
            `Jules API error: ${response.statusText}`,
            response.status,
            errorBody
          );
        }
        const text = await response.text();
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof JulesAPIError) {
          throw error;
        }

        const isAbort = error instanceof Error && error.name === 'AbortError';
        if ((isAbort || error instanceof Error) && attempt < this.maxRetries) {
          attempt++;
          lastError = error;
          continue;
        }
        throw new JulesAPIError(
          `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    throw new JulesAPIError(
      `Network error after ${this.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : 'Unknown error'
      }`
    );
  }

  async listSources(
    pageSize = 100,
    pageToken?: string
  ): Promise<ListSourcesResponse> {
    const response = await this.request<ListSourcesDto>(
      `/sources${this.buildQuery({ pageSize, pageToken })}`
    );
    return {
      sources: response.sources.map(normalizeSourceDto),
      nextPageToken: response.nextPageToken,
    };
  }

  async getSource(sourceName: string): Promise<Source> {
    const response = await this.request<JulesSourceDto>(`/${sourceName}`);
    return normalizeSourceDto(response);
  }

  async createSession(request: CreateSessionRequest): Promise<Session> {
    return this.request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async listSessions(
    pageSize = 20,
    pageToken?: string
  ): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>(
      `/sessions${this.buildQuery({ pageSize, pageToken })}`
    );
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/sessions/${sessionId}`);
  }

  async approvePlan(sessionId: string): Promise<Session> {
    await this.requestEmpty(`/sessions/${sessionId}:approvePlan`, {
      method: 'POST',
      body: '{}',
    });
    return this.getSession(sessionId);
  }

  async sendMessage(
    sessionId: string,
    request: SendMessageRequest
  ): Promise<Session> {
    await this.requestEmpty(`/sessions/${sessionId}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return this.getSession(sessionId);
  }

  /**
   * List activities and normalize the current Jules Activity DTO before callers
   * consume it. Current upstream activities use createTime and event-specific
   * objects rather than the older type/timestamp shape.
   */
  async listActivities(
    sessionId: string,
    pageSize = 50,
    pageToken?: string
  ): Promise<ListActivitiesResponse> {
    const endpoint = `/sessions/${sessionId}/activities`;
    try {
      const response = await this.request<ListActivitiesDto>(
        `${endpoint}${this.buildQuery({ pageSize, pageToken })}`
      );
      return {
        activities: (response.activities ?? []).map(normalizeJulesActivity),
        nextPageToken: response.nextPageToken,
      };
    } catch (error) {
      this.logActivityFailure(
        'listActivities',
        endpoint,
        {
          sessionId,
          pageSize,
          hasPageToken: Boolean(pageToken),
        },
        error
      );
      throw error;
    }
  }

  async getActivity(sessionId: string, activityId: string): Promise<Activity> {
    const endpoint = `/sessions/${sessionId}/activities/${activityId}`;
    try {
      const response = await this.request<JulesActivityDto>(endpoint);
      return normalizeJulesActivity(response);
    } catch (error) {
      this.logActivityFailure(
        'getActivity',
        endpoint,
        { sessionId, activityId },
        error
      );
      throw error;
    }
  }

  /**
   * Return activities newer than the supplied timestamp. The live Jules v1alpha
   * API currently rejects createTime as a query parameter, even though an example
   * in the public docs shows it. Use the supported pageSize/pageToken contract,
   * normalize all fetched pages, then filter locally by activity timestamp. An
   * opaque cursor continues a bounded result without silently dropping matches.
   *
   * @param sessionId - Jules session identifier.
   * @param since - Exclusive ISO 8601 lower-bound timestamp.
   * @param pageSize - Maximum number of matching activities to return.
   * @param cursor - Optional opaque continuation cursor from a previous response.
   * @returns A bounded activity page plus continuation metadata.
   */
  async listActivitiesSince(
    sessionId: string,
    since: string,
    pageSize = 50,
    cursor?: string
  ): Promise<ListActivitiesResponse> {
    const endpoint = `/sessions/${sessionId}/activities`;
    const sinceTime = Date.parse(since);
    if (!Number.isFinite(sinceTime)) {
      throw new JulesAPIError('Invalid activity since timestamp.', 400);
    }

    let cursorTime = Number.NEGATIVE_INFINITY;
    let cursorName = '';
    if (cursor) {
      const separator = cursor.indexOf('|');
      if (separator <= 0 || separator === cursor.length - 1) {
        throw new JulesAPIError('Invalid activity continuation cursor.', 400);
      }
      cursorTime = Number(cursor.slice(0, separator));
      try {
        cursorName = decodeURIComponent(cursor.slice(separator + 1));
      } catch {
        throw new JulesAPIError('Invalid activity continuation cursor.', 400);
      }
      if (!Number.isFinite(cursorTime) || !cursorName) {
        throw new JulesAPIError('Invalid activity continuation cursor.', 400);
      }
    }

    const upstreamPageSize = 100;
    const maxScanPages = 20;
    const matchingActivities: Activity[] = [];
    let pageToken: string | undefined;
    let pagesScanned = 0;

    try {
      do {
        if (pagesScanned >= maxScanPages) {
          throw new JulesAPIError(
            `Activity history exceeded the bounded scan limit of ${maxScanPages * upstreamPageSize} activities.`
          );
        }

        const response = await this.request<ListActivitiesDto>(
          `${endpoint}${this.buildQuery({
            pageSize: upstreamPageSize,
            pageToken,
          })}`
        );
        pagesScanned++;

        for (const rawActivity of response.activities ?? []) {
          const activity = normalizeJulesActivity(rawActivity);
          const activityTime = activity.timestamp
            ? Date.parse(activity.timestamp)
            : Number.NaN;
          if (Number.isFinite(activityTime) && activityTime > sinceTime) {
            matchingActivities.push(activity);
          }
        }

        pageToken = response.nextPageToken;
      } while (pageToken);

      matchingActivities.sort((left, right) => {
        const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
        const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;
        if (leftTime !== rightTime) return leftTime - rightTime;
        return left.name.localeCompare(right.name);
      });

      const remainingActivities = matchingActivities.filter((activity) => {
        const activityTime = activity.timestamp
          ? Date.parse(activity.timestamp)
          : Number.NaN;
        if (!Number.isFinite(activityTime)) return false;
        return (
          activityTime > cursorTime ||
          (activityTime === cursorTime && activity.name > cursorName)
        );
      });

      const activities = remainingActivities.slice(0, pageSize);
      const hasMore = remainingActivities.length > activities.length;
      const lastActivity = activities.at(-1);
      const lastTime = lastActivity?.timestamp
        ? Date.parse(lastActivity.timestamp)
        : Number.NaN;
      const nextCursor =
        hasMore && lastActivity && Number.isFinite(lastTime)
          ? `${lastTime}|${encodeURIComponent(lastActivity.name)}`
          : undefined;

      return {
        activities,
        hasMore,
        nextCursor,
      };
    } catch (error) {
      this.logActivityFailure(
        'listActivitiesSince',
        endpoint,
        {
          sessionId,
          since,
          pageSize,
          hasCursor: Boolean(cursor),
          pagesScanned,
        },
        error
      );
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestEmpty(`/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }

  async rejectPlan(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestEmpty(`/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }
}
