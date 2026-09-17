/**
 * Runtime-independent secret scanning utilities shared by Node and Worker entrypoints.
 */

/**
 * Detect common credential patterns in user-provided text.
 * @param text - Text to scan.
 * @returns True when a likely secret is present.
 */
export function containsSecret(text: string): boolean {
  if (!text) return false;

  const patterns = [
    /sk-[a-zA-Z0-9]{20,}/,
    /AIza[0-9A-Za-z-_]{35}/,
    /ghp_[a-zA-Z0-9]{36}/,
    /ghs_[a-zA-Z0-9]{36}/,
    /github_pat_[a-zA-Z0-9_]{82}/,
    /AKIA[0-9A-Z]{16}/,
    /sk-ant-[a-zA-Z0-9_-]{93}/,
    /hf_[a-zA-Z0-9]{37}/,
    /xox[pboa]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-z0-9]{32}/,
  ];

  return patterns.some((pattern) => pattern.test(text));
}
