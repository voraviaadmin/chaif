// src/receipts/vendorAdapters.ts
import { costcoAdapter } from "./vendors/costco";
import { amazonAdapter } from "./vendors/amazon";

export type ReceiptVendorKey = "Costco" | "Walmart" | "Kroger" | "Target" | "Amazon" | "Whole Foods" | "H-E-B" | string;

export type LogicalLineContext = {
  vendor: string | null;
};

export type VendorAdapter = {
  key: string;
  applies: (vendor: string | null) => boolean;
  

  // Optional hooks
  preprocessRawLines?: (rawLines: string[], ctx: LogicalLineContext) => string[];
  preprocessLogicalLines?: (logical: string[], ctx: LogicalLineContext) => string[];

  // Optional post-processing
  postprocessItems?: (items: ParsedLineItem[], ctx: LogicalLineContext) => ParsedLineItem[];
};

export type ParsedLineItem = {
  rawLineText: string;
  name: string;
  description: string | null;
  vendorSku: string | null;
  barcode: string | null;
  originalQuantity: number | null;
  originalUnit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
};

const adapters: VendorAdapter[] = [
  costcoAdapter,
  amazonAdapter,
];

export function getVendorAdapter(vendor: string | null): VendorAdapter | null {
  for (const a of adapters) {
    if (a.applies(vendor)) return a;
  }
  return null;
}





