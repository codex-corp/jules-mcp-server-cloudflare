/**
 * Security utilities for repository access control and validation.
 */

export { containsSecret } from './secret-detection.js';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Validates repository access based on an optional allowlist.
 * Ensures that operations are only performed on authorized repositories.
 */
export class RepositoryValidator {
  /** The list of allowed repositories, or null if no allowlist is configured. */
  private static allowedRepos: string[] | null = null;

  /**
   * Initializes the validator with allowed repositories from the Node environment.
   * @returns No return value.
   */
  static initialize(): void {
    const allowList = process.env.JULES_ALLOWED_REPOS;
    if (allowList) {
      this.allowedRepos = allowList
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
    }
  }

  /**
   * Validates that a repository is allowed to be accessed.
   * @param source - Source repository in sources/github/owner/repo format.
   * @returns No return value.
   */
  static validateRepository(source: string): void {
    if (!this.allowedRepos || this.allowedRepos.length === 0) {
      return;
    }

    const match = /^sources\/github\/(.+)$/.exec(source);
    if (!match) {
      throw new Error(
        `Invalid source format: ${source}. Expected sources/github/owner/repo`
      );
    }

    const repoPath = match[1];
    if (!this.allowedRepos.includes(repoPath)) {
      throw new SecurityError(
        `Security Error: Repository "${repoPath}" is not in the allowed list. ` +
          `Set JULES_ALLOWED_REPOS environment variable to authorize additional repositories.`
      );
    }
  }

  /**
   * Checks if an allowlist is currently configured and enabled.
   * @returns True if an allowlist is configured.
   */
  static isAllowlistEnabled(): boolean {
    return this.allowedRepos !== null && this.allowedRepos.length > 0;
  }

  /**
   * Gets the list of currently allowed repositories.
   * @returns Copy of the configured repositories, or null.
   */
  static getAllowedRepositories(): string[] | null {
    return this.allowedRepos ? [...this.allowedRepos] : null;
  }
}

/**
 * Truncates text to a specified maximum length at a nearby word boundary.
 * @param text - Text to truncate.
 * @param maxLength - Maximum length.
 * @returns Truncated string.
 */
export function smartTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  let truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.8) {
    truncated = truncated.substring(0, lastSpace);
  }

  return truncated.trim() + '...';
}

/**
 * Retries an asynchronous operation with exponential backoff.
 * @template T
 * @param fn - Async function to retry.
 * @param maxRetries - Maximum number of attempts.
 * @param baseDelay - Base delay in milliseconds.
 * @returns Operation result.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

/** Simple in-memory rate limiter for the local Node server. */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxRequests: number,
    private readonly timeWindowMs: number
  ) {}

  /**
   * Checks whether another request is allowed.
   * @returns True when allowed.
   */
  isAllowed(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(
      (timestamp) => now - timestamp < this.timeWindowMs
    );
    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}
