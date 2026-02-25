export type ExpiryCategory =
  | "LEAFY"
  | "POULTRY"
  | "RED_MEAT"
  | "DAIRY"
  | "FRUIT"
  | "VEG"
  | "COOKED_LEFTOVERS"
  | "PANTRY_DRY"
  | "UNKNOWN";

type ShelfLifeMap = Partial<Record<Exclude<ExpiryCategory, "UNKNOWN">, number>>;

const DEFAULT_SHELF_LIFE_DAYS: ShelfLifeMap = {
  LEAFY: 5,
  POULTRY: 2,
  RED_MEAT: 3,
  DAIRY: 10,
  FRUIT: 7,
  VEG: 10,
  COOKED_LEFTOVERS: 4,
  PANTRY_DRY: 180,
};

/**
 * EXPIRY_SHELF_LIFE_JSON example:
 * {
 *   "LEAFY": 5,
 *   "POULTRY": 2,
 *   "RED_MEAT": 3,
 *   "DAIRY": 10,
 *   "FRUIT": 7,
 *   "VEG": 10,
 *   "COOKED_LEFTOVERS": 4,
 *   "PANTRY_DRY": 180
 * }
 */
export function getShelfLifeDaysConfig(): ShelfLifeMap {
  const raw = process.env.EXPIRY_SHELF_LIFE_JSON;
  if (!raw) return DEFAULT_SHELF_LIFE_DAYS;

  try {
    const parsed = JSON.parse(raw);
    const out: ShelfLifeMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k).toUpperCase();
      const num = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(num) || num <= 0) continue;

      if (
        key === "LEAFY" ||
        key === "POULTRY" ||
        key === "RED_MEAT" ||
        key === "DAIRY" ||
        key === "FRUIT" ||
        key === "VEG" ||
        key === "COOKED_LEFTOVERS" ||
        key === "PANTRY_DRY"
      ) {
        (out as any)[key] = Math.floor(num);
      }
    }
    // If config was empty/invalid, fall back.
    return Object.keys(out).length ? out : DEFAULT_SHELF_LIFE_DAYS;
  } catch {
    return DEFAULT_SHELF_LIFE_DAYS;
  }
}

function norm(s: string): string {
  return s.toLowerCase();
}

function includesAny(haystack: string, needles: string[]): boolean {
  const h = norm(haystack);
  return needles.some((n) => h.includes(n));
}

/**
 * Deterministic keyword-based category classifier.
 * Keep it small + explainable. Tune keywords over time.
 */
export function estimateExpiryCategoryFromText(text: string): ExpiryCategory {
  const t = norm(text || "");
  if (!t) return "UNKNOWN";

  // cooked leftovers / prepared foods
  if (includesAny(t, ["leftover", "cooked", "prepared", "meal", "curry", "stew", "soup"])) {
    return "COOKED_LEFTOVERS";
  }

  // proteins
  if (includesAny(t, ["chicken", "turkey", "poultry"])) return "POULTRY";
  if (includesAny(t, ["beef", "pork", "lamb", "steak", "bacon", "ham"])) return "RED_MEAT";

  // dairy
  if (includesAny(t, ["milk", "yogurt", "cheese", "cream", "butter"])) return "DAIRY";

  // leafy greens
  if (includesAny(t, ["spinach", "lettuce", "kale", "arugula", "greens", "salad"])) return "LEAFY";

  // pantry dry
  if (includesAny(t, ["rice", "pasta", "noodle", "flour", "cereal", "oats", "lentil", "bean", "canned", "can "])) {
    return "PANTRY_DRY";
  }

  // fruit / veg (coarse)
  if (includesAny(t, ["apple", "banana", "berry", "orange", "grape", "mango", "peach", "pear", "fruit"])) return "FRUIT";
  if (includesAny(t, ["carrot", "broccoli", "tomato", "pepper", "onion", "potato", "cucumber", "zucchini", "veg", "vegetable"])) return "VEG";

  return "UNKNOWN";
}

export function estimateExpiresAtDeterministic(args: {
  baseDate: Date;
  textForClassification: string;
  expiresAtProvided?: Date | null;
}): Date | null {
  const { baseDate, textForClassification, expiresAtProvided } = args;

  // Respect explicit expiry if provided by caller.
  if (expiresAtProvided) return expiresAtProvided;

  const category = estimateExpiryCategoryFromText(textForClassification);
  if (category === "UNKNOWN") return null;

  const cfg = getShelfLifeDaysConfig();
  const days = (cfg as any)[category] as number | undefined;

  if (!days || !Number.isFinite(days) || days <= 0) return null;

  const d = new Date(baseDate);
  d.setDate(d.getDate() + Math.floor(days));
  return d;
}

export type ExpiryRisk = {
  type: "EXPIRY_RISK";
  severity: "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  title: string;
  why: string;
  dueBy: Date | null;
  canonicalItemId: string;
  recommendedNextStep?: string;
};

export function computeExpiryRiskAction(args: {
  canonicalItemId: string;
  itemName: string;
  expiresAt: Date | null;
  now: Date;
}): ExpiryRisk | null {
  const { canonicalItemId, itemName, expiresAt, now } = args;
  if (!expiresAt) return null;

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysToExpiry = Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay);

  // Buckets per spec
  let severity: "HIGH" | "MEDIUM" | "LOW" | null = null;
  let guidance = "";

  if (daysToExpiry <= 0) {
    severity = "HIGH";
    guidance = "Discard or confirm if frozen.";
  } else if (daysToExpiry <= 2) {
    severity = "HIGH";
    guidance = "Use in next 48h or freeze today.";
  } else if (daysToExpiry <= 5) {
    severity = "MEDIUM";
    guidance = "Plan meals around this this week.";
  } else if (daysToExpiry <= 10) {
    severity = "LOW";
    guidance = "Keep it in view—coming up soon.";
  } else {
    return null; // no noise
  }

  const title =
    daysToExpiry <= 0
      ? `${itemName} is expired`
      : `${itemName} expires in ~${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"}`;

  const why =
    daysToExpiry <= 0
      ? `Expiry date passed on ${expiresAt.toISOString().slice(0, 10)}.`
      : `Expiry due by ${expiresAt.toISOString().slice(0, 10)} (≈${daysToExpiry} days).`;

  return {
    type: "EXPIRY_RISK",
    severity,
    confidence: 0.7, // deterministic rule-based estimate
    title,
    why,
    dueBy: expiresAt,
    canonicalItemId,
    recommendedNextStep: guidance,
  };
}

export function severityRank(s: "HIGH" | "MEDIUM" | "LOW"): number {
  return s === "HIGH" ? 3 : s === "MEDIUM" ? 2 : 1;
}

export function compareDueBy(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}
