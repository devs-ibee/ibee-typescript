/**
 * Idempotency-key builders compatible with the IBEE portal.
 *
 * Generated keys always match `^[A-Za-z0-9_-]{1,128}$`.
 */

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "");
}

/** 32-bit FNV-1a over UTF-16 code units, rendered in base 36. */
export function fnv1a36(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function trimSegment(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const hash = fnv1a36(value);
  return `${value.slice(0, Math.max(0, maxLength - hash.length - 1))}-${hash}`;
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("-");
}

function randomHex16(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 16);
  let out = "";
  for (let i = 0; i < 16; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * Build a unique key for one logical request, e.g.
 * `buildIdempotencyKey("cloud-vm-start", vmId)`. Reuse the returned key when
 * retrying the same request.
 */
export function buildIdempotencyKey(
  scope: string,
  ...parts: Array<string | null | undefined>
): string {
  const raw = joinParts(parts);
  const scopeSegment = trimSegment(sanitizeSegment(String(scope ?? "")) || "request", 32);
  const partsSegment = trimSegment(sanitizeSegment(raw), 48);
  const partsHash = raw ? fnv1a36(raw) : null;
  return [scopeSegment, partsSegment, partsHash, randomHex16()]
    .filter(Boolean)
    .join("-")
    .slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

/**
 * Build a deterministic key: the same scope and parts always give the same
 * key (no random suffix).
 */
export function buildStableIdempotencyKey(
  scope: string,
  ...parts: Array<string | null | undefined>
): string {
  const raw = joinParts(parts);
  const scopeSegment = trimSegment(sanitizeSegment(String(scope ?? "")) || "request", 32);
  const partsSegment = trimSegment(sanitizeSegment(raw), 64);
  const partsHash = raw ? fnv1a36(raw) : "empty";
  return [scopeSegment, partsSegment, partsHash]
    .filter(Boolean)
    .join("-")
    .slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}
