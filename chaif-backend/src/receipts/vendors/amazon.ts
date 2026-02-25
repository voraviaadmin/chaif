import type { VendorAdapter } from "../vendorAdapters";

export const amazonAdapter: VendorAdapter = {
  key: "Amazon",
  applies(vendor: string | null): boolean {
    if (!vendor) return false;
    return vendor.toLowerCase().includes("amazon");
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