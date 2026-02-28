import crypto from "crypto";

export const NAME_NORMALIZER_VERSION = "nameNorm@2026-02-27";

/**
 * Phase 2 (v1):
 * - deterministic
 * - vendor-agnostic
 * - minimal cleaning only (Strategy A now)
 */

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * "displayName" is UI-friendly: keeps meaningful tokens, removes obvious noise.
 */
export function computeDisplayName(nameRaw: string): string {
  let s = String(nameRaw ?? "").trim();

  // Remove leading line numbers like "12  BANANAS" or "12) BANANAS"
  s = s.replace(/^\s*\d+\s*[\)\.\-:]?\s+/, "");

  // Remove trailing single-letter flags commonly seen on receipts ("Y", "N")
  // Example: "MILK 2% 3.49 Y" -> "MILK 2% 3.49"
  s = s.replace(/\s+[YN]\s*$/i, "");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * "normalizedName" is matching-friendly:
 * - uppercase
 * - & -> AND
 * - remove most punctuation
 * - collapse whitespace
 */
export function computeNormalizedName(displayName: string): string {
  let s = String(displayName ?? "").trim().toUpperCase();

  s = s.replace(/&/g, " AND ");

  // Keep letters/numbers/spaces only (drop punctuation)
  s = s.replace(/[^A-Z0-9 ]+/g, " ");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export function normalizeName(input: { nameRaw: string }) {
  const displayName = computeDisplayName(input.nameRaw);
  const normalizedName = computeNormalizedName(displayName);

  // Stable hash (write-once traceability)
  const hash = sha256Hex(`${NAME_NORMALIZER_VERSION}|${normalizedName}`);

  return {
    nameRaw: input.nameRaw,
    displayName,
    normalizedName,
    nameNormalizerVersion: NAME_NORMALIZER_VERSION,
    nameNormalizerHash: hash,
  };
}