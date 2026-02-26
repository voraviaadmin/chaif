// src/receipts/vendorAdapters.ts
import { costcoAdapter } from "./vendors/costco";
import { amazonAdapter } from "./vendors/amazon";
import { walmartAdapter } from "./vendors/walmart";



export type ReceiptVendorAdapter = {
  id: string;

  detect: (input: {
    rawLines: string[];
    headerText: string;
    fullText: string;
    vendorHint?: string | null;
  }) => boolean | number;

  preprocessRawLines?: (rawLines: string[], ctx: { vendor: string | null }) => string[];
  buildLogicalLines?: (rawLines: string[], ctx: { vendor: string | null }) => string[];
  preprocessLogicalLines?: (logical: string[], ctx: { vendor: string | null }) => string[];
  postprocessItems?: (items: any[], ctx: { vendor: string | null }) => any[];
};




export type LogicalLineContext = {
  vendor: string | null;
};

export type VendorAdapter = {
  key: string;

  

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



export function getVendorAdapter(vendor: string | null | undefined): VendorAdapter | null {
  if (!vendor) return null;
  const v = vendor.toLowerCase();

  return null;
}



const registry: ReceiptVendorAdapter[] = [
  walmartAdapter,
  costcoAdapter,
  amazonAdapter,
];

export function detectVendorAdapter(input: {
  rawLines: string[];
  headerText: string;
  fullText: string;
  vendorHint?: string | null;
}) {
  let best: { adapter: ReceiptVendorAdapter; score: number } | null = null;

  for (const adapter of registry) {
    const result = adapter.detect(input);
    const score = typeof result === "number" ? result : result ? 1 : 0;

    if (score > 0 && (!best || score > best.score)) {
      best = { adapter, score };
    }
  }

  return best?.adapter ?? null;
}

