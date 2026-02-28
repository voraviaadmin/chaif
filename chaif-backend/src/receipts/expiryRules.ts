export const EXPIRY_RULE_VERSION = "expRules@2026-02-28b";

export type ExpiryResult = {
  expiryDaysRaw: number | null;
  expiryDateRaw: Date | null;
  expiryConfidence: number | null; // 0..1
  expiryRuleVersion: string | null;
  ruleId: string | null;
};

function addDays(base: Date, days: number) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function includesAny(n: string, needles: string[]) {
  return needles.some((x) => n.includes(x));
}

/**
 * Phase 5 (v1+):
 * - deterministic
 * - based on categoryRaw + normalizedName hints
 * - skip isNonItem lines
 * - outputs RAW values only
 */
export function estimateExpiry(input: {
  purchaseDate: Date | null;
  categoryRaw: string | null;
  normalizedName: string | null;
  isNonItem: boolean;
}): ExpiryResult {
  if (input.isNonItem) {
    return {
      expiryDaysRaw: null,
      expiryDateRaw: null,
      expiryConfidence: null,
      expiryRuleVersion: null,
      ruleId: "SKIP_NON_ITEM",
    };
  }

  const category = (input.categoryRaw ?? "Other").trim();
  const n = (input.normalizedName ?? "").toUpperCase().trim();

  // If purchaseDate missing, we can still return days; date stays null unless caller passes a fallback.
  const baseDate = input.purchaseDate;

  // Non-perishables (explicit)
  if (
    category === "Household" ||
    category === "Apparel" ||
    category === "PersonalCare" ||
    category === "Discounts" ||
    category === "ReceiptMeta"
  ) {
    return {
      expiryDaysRaw: null,
      expiryDateRaw: null,
      expiryConfidence: 0.99,
      expiryRuleVersion: EXPIRY_RULE_VERSION,
      ruleId: "NON_PERISHABLE_001",
    };
  }

  // If unknown bucket, do not guess
  if (category === "Other") {
    return {
      expiryDaysRaw: null,
      expiryDateRaw: null,
      expiryConfidence: null,
      expiryRuleVersion: EXPIRY_RULE_VERSION,
      ruleId: "OTHER_NULL",
    };
  }

  // Category defaults (v1)
  let days: number | null = null;
  let conf = 0.6;
  let ruleId = "DEFAULT";

  // -------------------------
  // Eggs
  // -------------------------
  if (category === "Eggs") {
    days = 21;
    conf = 0.9;
    ruleId = "EGGS_021";
  }

  // -------------------------
  // Dairy
  // -------------------------
  else if (category === "Dairy") {
    days = 7;
    conf = 0.75;
    ruleId = "DAIRY_007";

    if (includesAny(n, ["MILK"])) {
      days = 7;
      conf = 0.8;
      ruleId = "DAIRY_MILK_007";
    }
    else if (includesAny(n, ["ALMOND", "OAT", "SOY"])) {
      days = 10;
      conf = 0.8;
      ruleId = "DAIRY_PLANT_MILK_010";
    }
    else if (includesAny(n, ["BUTTER"])) {
      days = 30;
      conf = 0.85;
      ruleId = "DAIRY_BUTTER_030";
    }
    else if (includesAny(n, ["YOGURT"])) {
      days = 10;
      conf = 0.8;
      ruleId = "DAIRY_YOGURT_010";
    }
    else if (includesAny(n, ["CHEESE"])) {
      days = 21;
      conf = 0.8;
      ruleId = "DAIRY_CHEESE_021";
    }
  }

  // -------------------------
  // Protein / Seafood
  // -------------------------
  else if (category === "Protein") {
    days = 3;
    conf = 0.75;
    ruleId = "PROTEIN_003";

    if (includesAny(n, ["FISH", "TILAPIA", "SALMON", "SHRIMP", "SEAFOOD"])) {
      days = 2;
      conf = 0.8;
      ruleId = "SEAFOOD_002";
    }
  }

  // -------------------------
  // Bakery
  // -------------------------
  else if (category === "Bakery") {
    days = 5;
    conf = 0.7;
    ruleId = "BAKERY_005";

    if (includesAny(n, ["CROISSANT", "CRSSNT"])) {
      days = 3;
      conf = 0.75;
      ruleId = "BAKERY_CROISSANT_003";
    } else if (includesAny(n, ["BREAD"])) {
      days = 7;
      conf = 0.75;
      ruleId = "BAKERY_BREAD_007";
    } else if (includesAny(n, ["TORTILLA", "TORT"])) {
      days = 10;
      conf = 0.7;
      ruleId = "BAKERY_TORT_010";
    }
  }

  // -------------------------
  // Snacks / Pantry / Beverages / Frozen
  // -------------------------
  else if (category === "Snacks") {
    days = 90;
    conf = 0.7;
    ruleId = "SNACKS_090";
  } else if (category === "Pantry") {
    days = 180;
    conf = 0.65;
    ruleId = "PANTRY_180";
  } else if (category === "Beverages") {
    days = 120;
    conf = 0.65;
    ruleId = "BEV_120";
  } else if (category === "Frozen") {
    days = 180;
    conf = 0.7;
    ruleId = "FROZEN_180";
  }

  // -------------------------
  // Produce (expanded hints to match your category rules)
  // -------------------------
  else if (category === "Produce") {
    days = 7;
    conf = 0.65;
    ruleId = "PRODUCE_007";

    // Herbs / leafy greens
    if (includesAny(n, ["CILANTRO", "BASIL", "PARSLEY", "HERB"])) {
      days = 4;
      conf = 0.75;
      ruleId = "PRODUCE_HERBS_004";
    } else if (includesAny(n, ["LETTUCE", "SPINACH", "GREENS"])) {
      days = 5;
      conf = 0.7;
      ruleId = "PRODUCE_GREENS_005";
    }

    // Berries
    else if (includesAny(n, ["STRAWBERRY", "STRAWBERRIES", "BLUEBERRY", "BLUEBERRIES", "RASPBERRY", "RASPBERRIES"])) {
      days = 4;
      conf = 0.8;
      ruleId = "PRODUCE_BERRIES_004";
    }

    // Bananas / avocados
    else if (includesAny(n, ["BANANA"])) {
      days = 5;
      conf = 0.75;
      ruleId = "PRODUCE_BANANA_005";
    } else if (includesAny(n, ["AVOCADO"])) {
      days = 5;
      conf = 0.75;
      ruleId = "PRODUCE_AVOCADO_005";
    }

    // Alliums / roots
    else if (includesAny(n, ["ONION", "GARLIC"])) {
      days = 21;
      conf = 0.7;
      ruleId = "PRODUCE_ALLIUM_021";
    } else if (includesAny(n, ["POTATO"])) {
      days = 30;
      conf = 0.7;
      ruleId = "PRODUCE_POTATO_030";
    }

    // Citrus / apples / pears / peaches
    else if (includesAny(n, ["APPLE", "ORANGE", "CITRUS", "LEMON", "LIME"])) {
      days = 14;
      conf = 0.7;
      ruleId = "PRODUCE_FRUIT_014";
    } else if (includesAny(n, ["PEAR", "PEARS", "PEACH", "PEACHES"])) {
      days = 7;
      conf = 0.7;
      ruleId = "PRODUCE_STONE_POME_007";
    }

    // Tomatoes / cucumbers
    else if (includesAny(n, ["TOMATO", "CUCUMBER"])) {
      days = 7;
      conf = 0.7;
      ruleId = "PRODUCE_TOM_CUC_007";
    }

    // Melons
    else if (includesAny(n, ["CANTALOUPE", "WATERMELON", "MELON"])) {
      days = 10;
      conf = 0.7;
      ruleId = "PRODUCE_MELON_010";
    }

    // Bulk produce (slightly shorter shelf life assumption)
    else if (includesAny(n, ["BULK"])) {
      days = 7;
      conf = 0.65;
      ruleId = "PRODUCE_BULK_007";
    }

    // Corn
    else if (includesAny(n, ["CORN"])) {
      days = 5;
      conf = 0.7;
      ruleId = "PRODUCE_CORN_005";
    }
  }

  // Anything else not covered: do not guess
  else {
    return {
      expiryDaysRaw: null,
      expiryDateRaw: null,
      expiryConfidence: null,
      expiryRuleVersion: EXPIRY_RULE_VERSION,
      ruleId: "UNHANDLED_CAT_NULL",
    };
  }

  const expiryDateRaw = days != null && baseDate ? addDays(baseDate, days) : null;

  return {
    expiryDaysRaw: days,
    expiryDateRaw,
    expiryConfidence: conf,
    expiryRuleVersion: EXPIRY_RULE_VERSION,
    ruleId,
  };
}