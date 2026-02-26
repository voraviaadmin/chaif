// src/receipts/vendors/amazon.ts
import type { ReceiptVendorAdapter } from "../vendorAdapters";

const amazonRe = /\bamazon\b/i;

export const amazonAdapter: ReceiptVendorAdapter = {
  id: "amazon",

  detect: ({ headerText, fullText }) => {
    if (amazonRe.test(headerText)) return 5;
    if (amazonRe.test(fullText)) return 2;
    return 0;
  },

  preprocessRawLines(lines: string[]): string[] {
    return lines.filter((l) => {
      const low = l.toLowerCase();
      if (
        low.includes("delivered") ||
        low.includes("return window") ||
        low.includes("sold by") ||
        low.includes("supplied by") ||
        low.includes("eligible through") ||
        low.includes("view related transactions") ||
        low.includes("order summary") ||
        low.includes("payment method") ||
        low.includes("grand total") ||
        low.includes("estimated tax") ||
        low.includes("shipping & handling") ||
        low.includes("free shipping")
      ) {
        return false;
      }
      return true;
    });
  },

  preprocessLogicalLines(lines: string[]): string[] {
    return lines.filter((l) => {
      const low = l.toLowerCase();
      if (
        low.startsWith("shipping") ||
        low.startsWith("free shipping") ||
        low.startsWith("delivered") ||
        low.startsWith("earn")
      ) {
        return false;
      }
      return true;
    });
  },
};