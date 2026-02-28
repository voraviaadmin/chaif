export const CATEGORY_RULE_VERSION = "catRules@2026-02-28";

export type CategoryResult = {
  categoryRaw: string;              // always set (fallback "Other")
  categoryRuleVersion: string;      // versioned for auditability
  ruleId: string;                   // debug trace
  confidence: number;               // 0..1 (optional)
  isNonItem: boolean;               // deterministic
  nonItemReason: string | null;     // deterministic reason
};

function hasAny(haystack: string, needles: string[]) {
  return needles.some((n) => haystack.includes(n));
}

function startsWithAny(haystack: string, prefixes: string[]) {
  return prefixes.some((p) => haystack.startsWith(p));
}

function looksLikeStoreMeta(n: string) {
  // city/state words, or "STORE ####", etc. Keep conservative.
  return (
    startsWithAny(n, ["STORE ", "MANAGER ", "CASHIER "]) ||
    hasAny(n, ["CEDAR PARK", "ROUND ROCK", "AUSTIN", "TEXAS"]) ||
    /#\s*\d{3,}/.test(n)
  );
}

export function categorizeLine(input: {
  normalizedName?: string | null;
  displayName?: string | null;
  vendorSku?: string | null;
}): CategoryResult {
  const n = (input.normalizedName ?? input.displayName ?? "").toUpperCase().trim();

  // -------------------------
  // 1) NON-ITEM / RECEIPT ARTIFACTS (do first)
  // -------------------------
  if (
    startsWithAny(n, [
      "DISCOUNT",
      "COUPON",
      "SAVINGS",
      "SUBTOTAL",
      "TOTAL",
      "TAX",
      "CHANGE",
      "CASH",
      "VISA",
      "MASTERCARD",
      "AMEX",
      "DEBIT",
      "CREDIT",
      "AUTH",
      "APPROVAL",
      "BALANCE",
      "ROUNDING",
      "PROMO",
    ]) ||
    hasAny(n, ["SUB TOTAL", "SALES TAX"]) ||
    looksLikeStoreMeta(n)
  ) {
    // Discounts are non-item but still useful to show
    const isDiscount = startsWithAny(n, ["DISCOUNT", "COUPON", "SAVINGS", "PROMO"]);
    return {
      categoryRaw: isDiscount ? "Discounts" : "ReceiptMeta",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: isDiscount ? "NI_DISC_001" : "NI_META_001",
      confidence: 0.99,
      isNonItem: true,
      nonItemReason: isDiscount ? "DISCOUNT_OR_PROMO" : "RECEIPT_META",
    };
  }

  // -------------------------
  // 2) APPAREL (not non-item by default; you may choose to exclude later)
  // -------------------------
  if (hasAny(n, ["T SHIRT", "TSHIRT", "T-SHIRT", "TANK", "BRA", "SOCK", "UNDERWEAR", "PANTS", "SHORTS", "HOODIE"])) {
    return {
      categoryRaw: "Apparel",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "AP_001",
      confidence: 0.9,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 3) HOUSEHOLD / PAPER / CLEANING
  // -------------------------
  if (
    hasAny(n, [
      "TOILET PAPER",
      "PAPER TOWEL",
      "TISSUE",
      "TRASH BAG",
      "DETERGENT",
      "BLEACH",
      "DISINFECT",
      "WIPES",
      "NAPKIN",
      "PAPER PLATE",
      "ALUMINUM FOIL",
      "ZIPLOC",
      "BAGGIE",
      "SPONGE",
      "DISH SOAP",
      "LAUNDRY",
      "TOWEL",
      "SOLO SPOON",
      "SPOON",
      "FORK",
      "KNIFE",
      "CUTLERY",
      "CUTTER",
      "SCISSORS",
      "PAPER CLIP",
      "CLIP",
      "STAPLER",
      "DIXIE",
      "BAG",
      "BAGS",
      "BAGLET",
      "CHINET",      
    ])
  ) {
    return {
      categoryRaw: "Household",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "HH_001",
      confidence: 0.95,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 4) PERSONAL CARE
  // -------------------------
  if (hasAny(n, ["SHAMPOO", "CONDITIONER", "SOAP", "DEODORANT", "TOOTHPASTE", "TOOTHBRUSH", "LOTION"])) {
    return {
      categoryRaw: "PersonalCare",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "PC_001",
      confidence: 0.95,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 5) DAIRY / EGGS
  // -------------------------
  if (hasAny(n, ["MILK", "YOGURT", "CHEESE", "BUTTER", "CREAM", "HALF AND HALF", "ORGANIC MLK"])) {
    return {
      categoryRaw: "Dairy",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "DA_001",
      confidence: 0.9,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  if (n.includes("EGG")) {
    return {
      categoryRaw: "Eggs",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "EG_001",
      confidence: 0.9,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 6) PRODUCE
  // -------------------------
  if (
    hasAny(n, [
      "BANANA",
      "AVOCADO",
      "TOMATO",
      "ONION",
      "CILANTRO",
      "LETTUCE",
      "SPINACH",
      "POTATO",
      "APPLE",
      "ORANGE",
      "CUCUMBER",
      "LIME",
      "LEMON",
      "GARLIC",
      "CANTALOUPE",
      "PEACH",
      "PEAR",
      "STRAWBERRY",
      "STRAWBERRIES",
      "BLUEBERRY",
      "BLUEBERRIES",
      "RASPBERRY",
      "RASPBERRIES",
      "BLACKBERRY",
      "BLACKBERRIES",
      "SWEET CORN",
      "PINEAPPLE",
      "MANGO",
      "KIWI",
      "PAPAYA",
      "MELON",
      "WATERMELON",
      "HONEYDEW",
      "GRAPE",
      "GRAPES",
      "GRAPEFRUIT",
      "GRAPEFRUIT",
      "PEAS",
      "CARROT",
      "OKRA",
      "CHILLI"
 


    ])
  ) {
    return {
      categoryRaw: "Produce",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "PR_001",
      confidence: 0.85,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 7) PROTEIN
  // -------------------------
  if (hasAny(n, ["CHICKEN", "BEEF", "PORK", "TURKEY", "SALMON", "SHRIMP", "FISH", "TILAPIA"])) {
    return {
      categoryRaw: "Protein",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "ME_001",
      confidence: 0.85,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 8) BAKERY / GRAINS
  // -------------------------
  if (hasAny(n, ["BREAD", "BAGEL", "TORT", "TORTILLA", "MUFFIN", "BUN", "CROISSANT"])) {
    return {
      categoryRaw: "Bakery",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "BA_001",
      confidence: 0.8,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 9) SNACKS / SWEETS
  // -------------------------
  if (hasAny(n, ["CHIP", "PRETZEL", "COOKIE", "BROWNIE", "CANDY", "CHOC", "SNACK", "CRACKER","YOGGIES","CAPE COD"])) {
    return {
      categoryRaw: "Snacks",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "SN_001",
      confidence: 0.75,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 10) BEVERAGES
  // -------------------------
  if (hasAny(n, ["WATER", "SODA", "JUICE", "COFFEE", "TEA", "COKE", "PEPSI", "7UP", "SPRITE", "GATORADE", "POWERADE"])) {
    return {
      categoryRaw: "Beverages",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "BV_001",
      confidence: 0.8,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // -------------------------
  // 11) PANTRY
  // -------------------------
  if (hasAny(n, ["RICE", "PASTA", "FLOUR", "SUGAR", "OIL", "BEAN", "SPICE", "SAUCE","DAL","LENTIL","BEANS"])) {
    return {
      categoryRaw: "Pantry",
      categoryRuleVersion: CATEGORY_RULE_VERSION,
      ruleId: "PN_001",
      confidence: 0.7,
      isNonItem: false,
      nonItemReason: null,
    };
  }

  // Default
  return {
    categoryRaw: "Other",
    categoryRuleVersion: CATEGORY_RULE_VERSION,
    ruleId: "OT_000",
    confidence: 0.3,
    isNonItem: false,
    nonItemReason: null,
  };
}