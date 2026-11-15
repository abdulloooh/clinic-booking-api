import { createHash } from "node:crypto";

export function jsonError(message: string) {
  return { error: message };
}

export function isValidEmail(email: string): boolean {
  // Practical check — not a full RFC parser.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Stable hash so key order in JSON does not change the body fingerprint. */
export function hashBody(value: unknown): string {
  const canonical = JSON.stringify(sortKeys(value));
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function encodeCursor(seq: string | number): string {
  return Buffer.from(String(seq), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function toIso(d: Date): string {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}
