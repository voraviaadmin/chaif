import type { ReceiptVendorAdapter, ParsedLineItem } from "../vendorAdapters";

const costcoRe = /\bcostco\b/i;

// Patterns
const skuStartRe = /^\d{4,8}\b/;
const pricedSkuLineRe = /^\d{4,8}\b.*\d{1,7}\.\d{2}\s*[YN]\b/i; // item line with trailing price + Y/N
const priceOnlyRe = /^-?\d{1,7}(?:\.\d{2})?\s*[YN]\b/i; // e.g. "5.69 N"
const promoPairRe = /^\d{5,7}\s*\/\s*(\d{5,8})$/; // e.g. "350276 /1207907" capture sku
const discountOnlyRe = /^\d{1,7}(?:\.\d{2})-$/; // e.g. "7.80-"

const noiseLineRe = /^(E|шш+|Member)$/i;
const bigNumberRe = /^\d{10,}$/;

function cleanLines(lines: string[]): string[] {
  return (lines || [])
    .map((l) => (l ?? "").trim())
    .filter(Boolean)
    .filter((l) => !noiseLineRe.test(l))
    .filter((l) => !bigNumberRe.test(l))
    .filter((l) => !l.toLowerCase().includes("orders & purchases"))
    .filter((l) => !l.toLowerCase().includes("costco.com"))
    .filter((l) => !/^\d+\/\d+$/.test(l)); // page markers like "1/2"
}

/**
 * Costco stable strategy (Phase 2C-B):
 * - Keep ITEM lines gross
 * - Keep DISCOUNT lines separate as "DISCOUNT [sku] 7.80-"
 * - Drop promo-pair lines from final output (but use them to label discount)
 * - Fix "SKU desc" followed later by "5.69 N" (Fiesta Dip) by attaching price-only line
 */
function buildCostcoLogicalStable(linesIn: string[]): string[] {
  const lines = cleanLines(linesIn);

  const out: string[] = [];
  let pendingSkuNoPrice: string | null = null;

  // Costco coupons usually come as:
  // promo pair line: "350276 /1207907"
  // discount line: "7.80-"
  // We'll capture the SKU from promo pair and label the next discount line.
  let pendingPromoSku: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Promo-pair line: capture sku and skip emitting this line
    const promoMatch = line.match(promoPairRe);
    if (promoMatch) {
      pendingPromoSku = promoMatch[1] || null;
      continue;
    }

    // Discount-only line: emit a clean DISCOUNT logical line so the core parser
    // creates a separate discount item (not stealing previous item name).
    if (discountOnlyRe.test(line)) {
      const skuTag = pendingPromoSku ? ` ${pendingPromoSku}` : "";
      out.push(`DISCOUNT${skuTag} ${line}`.replace(/\s{2,}/g, " ").trim());
      pendingPromoSku = null;
      continue;
    }

// --- Special-case: OCR price-shift swap ---
// pendingSkuNoPrice (Fiesta) + priced sku line (Cantaloupe 7.89 N) + next priceOnly (5.69 N)
// Real-world: Fiesta=7.89, Cantaloupe=5.69
if (pendingSkuNoPrice) {
  const curr = line;               // current line in loop
  const next = lines[i + 1];       // lookahead

  const isCurrPricedSku = curr && pricedSkuLineRe.test(curr);
  const isNextPriceOnly = next && priceOnlyRe.test(next);

  if (isCurrPricedSku && isNextPriceOnly) {
    // Extract trailing price token from current priced sku line (e.g. "7.89 N")
    const m = curr.match(/(\d{1,7}\.\d{2}\s*[YN])\s*$/i);
    if (m) {
      const currPriceToken = m[1]; // "7.89 N"
      const currBase = curr.replace(/(\d{1,7}\.\d{2}\s*[YN])\s*$/i, "").trim();

      const nextPriceToken = next.trim(); // "5.69 N"

      // 1) Pending SKU gets current priced sku's price token (Fiesta gets 7.89 N)
      out.push(`${pendingSkuNoPrice} ${currPriceToken}`.replace(/\s{2,}/g, " ").trim());

      // 2) Current priced sku gets next priceOnly token (Cantaloupe gets 5.69 N)
      out.push(`${currBase} ${nextPriceToken}`.replace(/\s{2,}/g, " ").trim());

      pendingSkuNoPrice = null;
      i++; // consume next line (priceOnly) since we used it
      continue;
    }
  }
}



    // Fiesta Dip pattern: SKU line without price, later a price-only line
    if (pendingSkuNoPrice && priceOnlyRe.test(line)) {
      out.push(`${pendingSkuNoPrice} ${line}`.replace(/\s{2,}/g, " ").trim());
      pendingSkuNoPrice = null;
      continue;
    }

    const isSku = skuStartRe.test(line);
    const isPricedSku = pricedSkuLineRe.test(line);

    // Hold SKU-without-price until we see a price-only line later
    if (isSku && !isPricedSku) {
      pendingSkuNoPrice = line;
      continue;
    }

    // Normal emit
    out.push(line);
  }

  if (pendingSkuNoPrice) out.push(pendingSkuNoPrice);

  return out;
}

function relabelDiscountItems(items: ParsedLineItem[]): ParsedLineItem[] {
  // Safety net: if any negative row slips through with a non-discount name,
  // rename it to DISCOUNT so you can filter it later.
  return items.map((it) => {
    const amt = (typeof it.lineTotal === "number" ? it.lineTotal : typeof it.unitPrice === "number" ? it.unitPrice : null);
    if (amt != null && amt < 0) {
      const name = (it.name || "").trim();
      if (!/^DISCOUNT\b/i.test(name)) {
        return { ...it, name: `DISCOUNT ${name}`.trim() };
      }
    }
    return it;
  });
}

export const costcoAdapter: ReceiptVendorAdapter = {
  id: "costco",

  detect: ({ headerText, fullText }) => {
    if (costcoRe.test(headerText)) return 5;
    if (costcoRe.test(fullText)) return 2;
    return 0;
  },

  preprocessRawLines(rawLines) {
    return cleanLines(rawLines);
  },

  preprocessLogicalLines(logicalLines) {
    return buildCostcoLogicalStable(logicalLines);
  },

  postprocessItems(items) {
    // Keep it simple & stable: do NOT attempt NET math here.
    // Just clean trailing Y/N that sometimes sticks to names and relabel discount rows.
    const cleaned = items.map((it) => ({
      ...it,
      name: (it.name || "").replace(/\s+[YN]\b/i, "").trim(),
    }));
    return relabelDiscountItems(cleaned);
  },
};