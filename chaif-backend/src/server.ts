import dotenv from "dotenv";
dotenv.config(); // must happen before other imports that read env

import express from "express";
import { requireVoraviaJwt } from "./middleware/auth";
import { prisma } from "./prisma";
import { Prisma, HouseholdMemberRole } from "@prisma/client";
import { estimateExpiresAtDeterministic } from "./expiryRules";
import { generateAssistantActions } from "./assistantEngine";
import { uploadReceiptHandler } from "./receipts/receiptUpload";
import multer from "multer";
import jwt from "jsonwebtoken";


const app = express();
const port = Number(process.env.PORT || 8790);

// ✅ required for req.body
app.use(express.json({ limit: "2mb" }));

// (Optional) if behind a proxy/load balancer later
// app.set("trust proxy", 1);

// ✅ multipart upload for receipt images/PDFs (Phase 2C)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.RECEIPT_UPLOAD_MAX_BYTES || 12 * 1024 * 1024), // default 12MB
  },
  fileFilter: (_req, file, cb) => {
    const ok = [
      "image/jpeg",
      "image/png",
      "application/pdf",
      "image/webp",
    ].includes(file.mimetype);
    if (!ok) return cb(new Error("Unsupported file type"));
    cb(null, true);
  },
});



function toNumber(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeUnit(u: any): string {
  return String(u ?? "").trim().toLowerCase();
}

const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();


function convertToGramsIfSafe(originalQty: any, originalUnit: any): {
  grams: number | null;
  method: string | null;
  isVolumeOrUnknown: boolean;
} {
  const qty = toNumber(originalQty);
  const unit = normalizeUnit(originalUnit);

  if (qty === null || !unit) {
    return { grams: null, method: null, isVolumeOrUnknown: true };
  }

  // ✅ weight -> grams (safe)
  if (unit === "g" || unit === "gram" || unit === "grams") return { grams: qty, method: "UNIT_G", isVolumeOrUnknown: false };
  if (unit === "kg" || unit === "kilogram" || unit === "kilograms") return { grams: qty * 1000, method: "UNIT_KG", isVolumeOrUnknown: false };
  if (unit === "oz" || unit === "ounce" || unit === "ounces") return { grams: qty * 28.349523125, method: "UNIT_OZ", isVolumeOrUnknown: false };
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") return { grams: qty * 453.59237, method: "UNIT_LB", isVolumeOrUnknown: false };

  // ❌ volume/unknown -> do not convert (LOCKED)
  // includes: ml/l/tsp/tbsp/cup/pint/quart/gallon etc.
  return { grams: null, method: null, isVolumeOrUnknown: true };
}


async function inventoryEvent(args: {
  householdId: string;
  type: any; // InventoryEventType
  actorUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  payload: any;
}) {
  return prisma.inventoryEvent.create({
    data: {
      householdId: args.householdId,
      type: args.type,
      actorUserId: args.actorUserId ?? null,
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
      payload: args.payload,
    },
  });
}


async function audit({
  actorType,
  actorId,
  action,
  entityType,
  entityId,
  householdId,
  before,
  after,
  reason,
  req,
}: {
  actorType: "SYSTEM" | "USER" | "ADMIN" | "SUPPORT" | "IMPORT" | "SVC";
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  householdId?: string | null;
  before?: any;
  after?: any;
  reason?: string | null;
  req: any;
}) {
  const requestId = req.headers["x-request-id"] ?? null;
  const correlationId = req.headers["x-correlation-id"] ?? null;

  const ip =
    (req.headers["x-forwarded-for"]?.toString().split(",")[0] ??
      req.socket?.remoteAddress) ||
    null;

  const userAgent = req.headers["user-agent"] ?? null;

  // If your auth middleware exposes these, wire them in; otherwise keep null for now
  const authProvider = req.auth?.provider ?? null;
  const jwtKid = req.auth?.kid ?? null;

  await prisma.auditEvent.create({
    data: {
      actorType: actorType as any,
      actorId: actorId ?? null,
      action,
      entityType,
      entityId,
      householdId: householdId ?? null,
      before: before ?? null,
      after: after ?? null,
      reason: reason ?? null,
      requestId,
      correlationId,
      ip,
      userAgent,
      authProvider,
      jwtKid,
    },
  });
}


// ---------------------------
// Phase 1 Freeze Helpers
// ---------------------------

function requireUserId(req: express.Request): string {
  const id = req.user?.id;
  if (!id) throw Object.assign(new Error("UNAUTHORIZED"), { status: 401 });
  return id;
}

async function assertHouseholdMemberOrThrow(
  tx: Prisma.TransactionClient,
  userId: string,
  householdId: string
) {
  const membership = await tx.householdMember.findUnique({
    where: { householdId_userId: { householdId, userId } },
    select: { householdId: true, userId: true, role: true },
  });
  if (!membership) {
    throw Object.assign(new Error("FORBIDDEN_HOUSEHOLD"), { status: 403 });
  }
  return membership; // { householdId, userId, role }
}


function requireHouseholdId(req: express.Request): string {
  const fromBody = (req.body && (req.body.householdId ?? req.body.householdID)) as any;
  const fromQuery = (req.query && (req.query.householdId ?? req.query.householdID)) as any;
  const fromParams = (req.params && (req.params.householdId ?? req.params.householdID)) as any;

  const householdId = String(fromBody ?? fromQuery ?? fromParams ?? "").trim();
  if (!householdId) throw Object.assign(new Error("MISSING_householdId"), { status: 400 });
  return householdId;
}

type MemberContext = {
  userId: string;
  householdId: string;
  role: HouseholdMemberRole;
};

async function requireMember(
  tx: Prisma.TransactionClient,
  req: express.Request
): Promise<MemberContext> {
  const userId = requireUserId(req);
  const householdId = requireHouseholdId(req);
  const membership = await assertHouseholdMemberOrThrow(tx, userId, householdId);
  return { userId, householdId, role: membership.role };
}

async function requireOwner(
  tx: Prisma.TransactionClient,
  req: express.Request
): Promise<MemberContext> {
  const ctx = await requireMember(tx, req);
  if (ctx.role !== "OWNER") {
    throw Object.assign(new Error("FORBIDDEN_OWNER_ONLY"), { status: 403 });
  }
  return ctx;
}

// ---------------------------
// Guest capability (NOT a household member)
// ---------------------------
type GuestCapability = {
  targetHouseholdId: string;
  scopes: string[];
  guestUserId?: string;
  jti?: string;
};

function requireGuestCapability(req: express.Request, requiredScope: string): GuestCapability {
  const header = String(req.headers["authorization"] ?? "").trim();
  const token =
    header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : String(req.headers["x-guest-token"] ?? "").trim();

  if (!token) throw Object.assign(new Error("UNAUTHORIZED_GUEST_TOKEN_MISSING"), { status: 401 });

  const secret = process.env.GUEST_CAPABILITY_JWT_SECRET;
  if (!secret) throw Object.assign(new Error("SERVER_MISCONFIG_GUEST_SECRET"), { status: 500 });

  let payload: any;
  try {
    payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch {
    throw Object.assign(new Error("UNAUTHORIZED_GUEST_TOKEN_INVALID"), { status: 401 });
  }

  const targetHouseholdId = String(payload?.targetHouseholdId ?? "").trim();
  const scopes = Array.isArray(payload?.scopes) ? payload.scopes.map((s: any) => String(s)) : [];
  if (!targetHouseholdId) throw Object.assign(new Error("UNAUTHORIZED_GUEST_TOKEN_BAD_PAYLOAD"), { status: 401 });
  if (!scopes.includes(requiredScope)) throw Object.assign(new Error("FORBIDDEN_GUEST_SCOPE"), { status: 403 });

  return {
    targetHouseholdId,
    scopes,
    guestUserId: payload?.guestUserId ? String(payload.guestUserId) : undefined,
    jti: payload?.jti ? String(payload.jti) : undefined,
  };
}

function parseDecimalStrict(v: any, fieldName: string): Prisma.Decimal {
  // Accept numeric strings or numbers; convert to string to preserve intent
  if (v === null || v === undefined) {
    throw Object.assign(new Error(`MISSING_${fieldName}`), { status: 400 });
  }
  const s = typeof v === "string" ? v.trim() : String(v);
  // basic sanity
  if (s.length === 0) throw Object.assign(new Error(`MISSING_${fieldName}`), { status: 400 });
  // Prisma.Decimal will throw on invalid
  const d = new Prisma.Decimal(s);
  if (!d.isFinite() || d.lte(0)) {
    throw Object.assign(new Error(`INVALID_${fieldName}`), { status: 400 });
  }
  return d;
}

function parseOptionalRequestId(req: any): string | null {
  const rid = req?.body?.requestId ?? null;
  if (rid === null || rid === undefined) return null;
  const s = String(rid).trim();
  return s.length ? s : null;
}

function requireRequestId(req: any): string {
  const rid = parseOptionalRequestId(req);
  if (!rid) throw Object.assign(new Error("MISSING_requestId"), { status: 400 });
  return rid;
}

async function findPriorEvent(
  tx: Prisma.TransactionClient,
  householdId: string,
  requestId: string
) {
  return tx.inventoryEvent.findFirst({
    where: { householdId, requestId },
    select: { id: true, entityId: true, entityType: true, type: true, createdAt: true },
  });
}

// Optional: safer error response (prevents raw Prisma error leakage)
function sendSafeError(res: express.Response, e: any) {
  const status = e?.status ?? 500;
  if (status === 500) {
    // log server-side (ok during Phase-1; remove console noise later if you have logger)
    console.error(e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
  // Map known statuses
  if (status === 401) return res.status(401).json({ error: "UNAUTHORIZED" });
  if (status === 403) return res.status(403).json({ error: "FORBIDDEN" });
  if (status === 404) return res.status(404).json({ error: "NOT_FOUND" });
  return res.status(status).json({ error: e?.message ?? "BAD_REQUEST" });
}









app.get("/health", (_req, res) => res.json({ ok: true, service: "cHaif" }));

// ✅ Protected test endpoint
app.get("/v1/me", requireVoraviaJwt, (req, res) => {
  res.json({ ok: true, auth: (req as any).auth, user: (req as any).user });
});



// ----------------------------
// Scope 1: Guest Cook Requests (NO household membership)
// ----------------------------
//
// Guest is an external principal. Access is via capability token only.
// Guests never get inventory visibility; only availability outcomes + substitutions filtered to provided alternatives.
//
app.post("/v1/guest/cook-request", async (req, res) => {
  try {
    const cap = requireGuestCapability(req, "cook_request:create");
    const householdId = cap.targetHouseholdId;

    const ingredients = (req.body?.ingredients ?? []) as Array<{
      name: string;
      alternatives?: string[];
    }>;

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "ingredients[] is required" });
    }
    if (ingredients.length > 50) {
      return res.status(400).json({ error: "Too many ingredients (max 50)" });
    }

    // Load active item names only (privacy-safe; not returned raw)
    const lots = await prisma.inventoryLot.findMany({
      where: { householdId, quantityRemaining: { gt: 0 } },
      select: { canonicalItem: { select: { name: true, normalized: true } } },
    });

    const invNames = lots
      .map((l) => normalizeName(l.canonicalItem?.name || ""))
      .filter(Boolean);

    const invJoined = " " + invNames.join("  ") + " ";
    const isAvailable = (raw: string): boolean => {
      const n = normalizeName(String(raw || ""));
      if (!n) return false;
      return invJoined.includes(" " + n + " ");
    };

    const results = ingredients.map((ing) => {
      const requested = String(ing?.name ?? "").trim();
      const alternatives = Array.isArray(ing?.alternatives) ? ing.alternatives.map(String) : [];
      const available = isAvailable(requested);

      if (available) return { requested, available: true, chosen: requested, substitutions: [] as string[] };
      const availableSubs = alternatives.filter((a) => isAvailable(a));
      return { requested, available: false, chosen: availableSubs[0] ?? null, substitutions: availableSubs };
    });

    return res.json({
      ok: true,
      householdId,
      results,
      notes: { privacy: "No inventory details are returned. Substitutions are filtered to the alternatives you provided." },
    });
  } catch (err) {
    sendSafeError(res, err);
  }
});


// ----------------------------
// Phase 2A: Receipts Raw
// ----------------------------

// ✅ create receipt raw + lines
app.post("/v1/receipts/raw", requireVoraviaJwt, async (req, res) => {
  try {

    const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
    const userId = ctx.userId;
    const householdId = ctx.householdId;

    const {
      vendor,
      purchaseDate,
      rawText,
      rawJson,
      sourceType,
      sourceRef,
      sourceHash,
      currency,
      lines,
    } = req.body;


    if (!vendor) {
      return res
        .status(400)
        .json({ error: "vendor is required" });
    }


    const householdName = req.body.householdName ?? "Household";


    await prisma.household.upsert({
      where: { id: householdId },
      update: {},
      create: { id: householdId, name: householdName },
    });



    const receipt = await prisma.receiptRaw.create({
      data: {
        householdId,
        vendor,
        purchaseDate: purchaseDate ? new Date(purchaseDate) : null,
        rawText: rawText ?? null,
        rawJson: rawJson ?? null,
        sourceType: sourceType ?? null,
        sourceRef: sourceRef ?? null,
        sourceHash: sourceHash ?? null,
        currency: currency ?? null,
        lines: Array.isArray(lines) && lines.length
          ? {
            create: lines.map((l: any, idx: number) => ({
              lineNumber: Number.isInteger(l.lineNumber) ? l.lineNumber : idx + 1,
              rawLineText: l.rawLineText ?? null,

              vendorSku: l.vendorSku ?? null,
              barcode: l.barcode ?? null,
              name: l.name ?? null,
              description: l.description ?? null,

              originalQuantity: l.originalQuantity ?? null,
              originalUnit: l.originalUnit ?? null,
              originalPrice: l.originalPrice ?? null,

              unitPrice: l.unitPrice ?? null,
              lineTotal: l.lineTotal ?? null,
            })),
          }
          : undefined,
      },
      include: { lines: true },
    });

    await audit({
      actorType: (req as any).user ? "USER" : "SYSTEM",
      actorId: (req as any).user?.id ?? null,
      action: "RECEIPT_RAW_CREATED",
      entityType: "ReceiptRaw",
      entityId: receipt.id,
      householdId,
      after: { vendor, purchaseDate, sourceType, sourceRef },
      req,
    });

    return res.status(201).json(receipt);
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});


// Phase 2C — Upload receipt image/PDF -> OCR -> ReceiptRaw + ReceiptLineRaw[]
// Multipart field name: "file"
// Phase 2C — Upload receipt image/PDF -> OCR -> ReceiptRaw + ReceiptLineRaw[]
// Multipart field name: "file"
app.post(
  "/v1/receipts/upload",
  requireVoraviaJwt,
  upload.single("file"),
  uploadReceiptHandler({ prisma, requireMember, audit })
);




// ✅ read receipt raw + lines + normalized
app.get("/v1/receipts/:id", requireVoraviaJwt, async (req, res) => {
  try {
    const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
    const id = String(req.params.id);

    const receipt = await prisma.receiptRaw.findFirst({
      where: { id, householdId: ctx.householdId, deletedAt: null },
      include: {
        lines: {
          where: { deletedAt: null },
          include: { normalized: true },
          orderBy: { lineNumber: "asc" },
        },
      },
    });

    if (!receipt) return res.status(404).json({ error: "Receipt not found" });

    await audit({
      actorType: (req as any).user ? "USER" : "SYSTEM",
      actorId: (req as any).user?.id ?? null,
      action: "RECEIPT_RAW_READ",
      entityType: "ReceiptRaw",
      entityId: id,
      householdId: receipt.householdId,
      req,
    });

    return res.json(receipt);
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});

// ----------------------------
// Phase 2A: Normalize Propose (no AI yet)
// ----------------------------
app.post("/v1/normalize/propose", requireVoraviaJwt, async (req, res) => {
  try {
    const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
    const { receiptId, normalizationEngineVersion = "norm-v1" } = req.body;
    if (!receiptId)
      return res.status(400).json({ error: "receiptId is required" });

    const receipt = await prisma.receiptRaw.findFirst({
      where: { id: receiptId, householdId: ctx.householdId, deletedAt: null },
      include: { lines: { where: { deletedAt: null }, orderBy: { lineNumber: "asc" } } },
    });
    if (!receipt) return res.status(404).json({ error: "Receipt not found" });

    const results: any[] = [];

    for (const line of receipt.lines) {
      // Skip if already normalized
      const existing = await prisma.normalizedLineItem.findFirst({
        where: { receiptLineRawId: line.id, deletedAt: null },
      });
      if (existing) {
        results.push(existing);
        continue;
      }

      // Deterministic match: SKU first
      let canonical: any = null;

      if (line.vendorSku) {
        canonical = await prisma.canonicalItem.findFirst({
          where: {
            vendor: receipt.vendor,
            vendorSku: line.vendorSku,
            deletedAt: null,
          },
        });
      }

      // Alias fallback (exact match on name)
      if (!canonical && line.name) {
        const alias = await prisma.itemAlias.findFirst({
          where: { aliasText: line.name, deletedAt: null },
          include: { canonicalItem: true },
        });
        canonical = alias?.canonicalItem ?? null;
      }

      const decisionStatus = canonical ? "PROPOSED" : "NEEDS_REVIEW";
      const matchMethod = canonical ? (line.vendorSku ? "SKU" : "MANUAL") : null;
      const conv = convertToGramsIfSafe(line.originalQuantity, line.originalUnit);


      // ✅ IMPORTANT: your schema uses proposed/final canonical IDs, not canonicalItemId
      const normalized = await prisma.normalizedLineItem.create({
        data: {
          householdId: receipt.householdId,
          receiptId: receipt.id,                 // ✅ required in your model
          receiptLineRawId: line.id,             // ✅ required + unique

          rawDescription: line.description ?? line.rawLineText ?? null,
          normalizedText: line.name ?? null,

          originalQuantity: line.originalQuantity ?? null,
          originalUnit: line.originalUnit ?? null,

          quantityGrams: conv.grams,
          quantityEach: null, // LOCKED: we do NOT treat volume as "each"
          matchMethod: ((matchMethod ?? null) as any),

          evidence: canonical
            ? {
              matchedOn: ["vendorSku"],
              candidates: [{ canonicalId: canonical.id, score: 1.0 }],
              unitConversion: {
                originalQuantity: line.originalQuantity ?? null,
                originalUnit: line.originalUnit ?? null,
                quantityGrams: conv.grams,
                method: conv.method,
                unresolvedReason: conv.isVolumeOrUnknown ? "VOLUME_OR_UNKNOWN_UNIT" : null,
              },
            }
            : {
              matchedOn: [],
              candidates: [],
              unitConversion: {
                originalQuantity: line.originalQuantity ?? null,
                originalUnit: line.originalUnit ?? null,
                quantityGrams: conv.grams,
                method: conv.method,
                unresolvedReason: conv.isVolumeOrUnknown ? "VOLUME_OR_UNKNOWN_UNIT" : null,
              },
            },


          decisionStatus: decisionStatus as any,
          //matchMethod: matchMethod as any,
          confidenceScore: canonical ? 1.0 : null,

          modelVersion: null,
          normalizationEngineVersion,
          //evidence: canonical
          //  ? { matchedOn: ["vendorSku"], candidates: [{ canonicalId: canonical.id, score: 1.0 }] }
          //  : { matchedOn: [], candidates: [] },

          suggestedAt: new Date(),
          decidedByType: "SYSTEM" as any,
          decidedById: req.user?.id ?? null,


          proposedCanonicalItemId: canonical?.id ?? null, // ✅ proposal field
        },
      });

      await audit({
        actorType: (req as any).user ? "USER" : "SYSTEM",
        actorId: (req as any).user?.id ?? null,
        action: "NORMALIZATION_PROPOSED",
        entityType: "NormalizedLineItem",
        entityId: normalized.id,
        householdId: receipt.householdId,
        after: {
          receiptId: receipt.id,
          receiptLineRawId: line.id,
          proposedCanonicalItemId: canonical?.id ?? null,
          decisionStatus,
          matchMethod,
          normalizationEngineVersion,
        },
        req,
      });

      results.push(normalized);
    }

    return res.json({ receiptId, count: results.length, items: results });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});



// APPROVE a normalized line item (lock decision)
app.post("/v1/normalize/:id/approve", requireVoraviaJwt, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { finalCanonicalItemId, createAlias = true, aliasText } = req.body ?? {};

    if (!finalCanonicalItemId) {
      return res.status(400).json({ error: "finalCanonicalItemId is required" });
    }

    const existing = await prisma.normalizedLineItem.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ error: "NormalizedLineItem not found" });

    const canonical = await prisma.canonicalItem.findFirst({
      where: { id: finalCanonicalItemId, deletedAt: null },
    });
    if (!canonical) return res.status(404).json({ error: "CanonicalItem not found" });

    // idempotent approve
    if (existing.decisionStatus === "APPROVED" && existing.finalCanonicalItemId === canonical.id) {
      return res.json({ ok: true, item: existing, idempotent: true });
    }

    const before = existing;

    const updated = await prisma.normalizedLineItem.update({
      where: { id },
      data: {
        finalCanonicalItemId: canonical.id,
        // optional: keep proposed aligned to reduce ambiguity early
        proposedCanonicalItemId: canonical.id,

        decisionStatus: "APPROVED",
        reviewedAt: new Date(),
        finalizedAt: new Date(),
        reviewedByUserId: req.user?.id ?? null,

        decidedByType: "USER",
        decidedById: req.user?.id ?? null,
      },
    });

    // Optional: create alias for future auto-match.
    // Your ItemAlias model (from earlier screenshots) uses aliasText + canonicalItemId.
    // We'll keep it GLOBAL by default (householdId = null), and vendor optional.
    if (createAlias) {
      const text = String(aliasText ?? updated.normalizedText ?? "").trim();
      if (text) {
        // If you have @@unique([canonicalItemId, aliasText]) then this upsert works.
        // If Prisma complains about the compound key name, switch to findFirst+create.
        const aliasNormalized = normalizeName(text);

        await prisma.itemAlias.upsert({
          where: {
            canonicalItemId_aliasText: {
              canonicalItemId: canonical.id,
              aliasText: text,
            },
          } as any,
          update: {
            deletedAt: null,
            normalized: aliasNormalized, // ✅ add
          } as any,
          create: {
            canonicalItemId: canonical.id,
            aliasText: text,
            normalized: aliasNormalized, // ✅ add
            householdId: null,
            vendor: canonical.vendor ?? null,
            source: "approve_flow",
            deletedAt: null,
          } as any,
        });


      }
    }

    await audit({
      actorType: "USER",
      actorId: req.user?.id ?? null,
      action: "NORMALIZATION_APPROVED",
      entityType: "NormalizedLineItem",
      entityId: updated.id,
      householdId: updated.householdId,
      before,
      after: updated,
      req,
    });

    return res.json({ ok: true, item: updated });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});



app.post("/v1/canonical-items", requireVoraviaJwt, async (req, res) => {
  try {
    const { vendor, vendorSku, name, description, defaultUnit } = req.body ?? {};
    if (!vendor || !vendorSku || !name) {
      return res.status(400).json({ error: "vendor, vendorSku, and name are required" });
    }

    const before = await prisma.canonicalItem.findFirst({
      where: { vendor, vendorSku, deletedAt: null },
    });

    const normalized = normalizeName(name);


    const item = await prisma.canonicalItem.upsert({
      where: { vendor_vendorSku: { vendor, vendorSku } } as any,
      update: {
        name,
        normalized,
        description: description ?? null,
        defaultUnitCode: defaultUnit ?? null,
        deletedAt: null,
      } as any,
      create: {
        vendor,
        vendorSku,
        name,
        normalized,
        description: description ?? null,
        defaultUnitCode: defaultUnit ?? null,
      } as any,
    });

    await audit({
      actorType: "USER",
      actorId: req.user?.id ?? null,
      action: before ? "CANONICAL_ITEM_UPDATED" : "CANONICAL_ITEM_CREATED",
      entityType: "CanonicalItem",
      entityId: item.id,
      householdId: null, // GLOBAL
      before: before ?? null,
      after: item,
      req,
    });

    return res.status(before ? 200 : 201).json(item);
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});


app.post("/v1/item-aliases", requireVoraviaJwt, async (req, res) => {
  try {
    const { canonicalItemId, aliasText, householdId = null, vendor = null, source = "manual" } = req.body ?? {};

    if (householdId) {
      await prisma.$transaction((tx) => requireOwner(tx, req));
    }
    if (!canonicalItemId || !aliasText) {
      return res.status(400).json({ error: "canonicalItemId and aliasText are required" });
    }

    const canonical = await prisma.canonicalItem.findFirst({
      where: { id: canonicalItemId, deletedAt: null },
    });
    if (!canonical) return res.status(404).json({ error: "CanonicalItem not found" });

    const text = String(aliasText).trim();
    if (!text) return res.status(400).json({ error: "aliasText cannot be empty" });

    const before = await prisma.itemAlias.findFirst({
      where: { canonicalItemId, aliasText: text },
    });

    const alias = await prisma.itemAlias.upsert({
      where: { canonicalItemId_aliasText: { canonicalItemId, aliasText: text } } as any,
      update: { deletedAt: null, householdId, vendor, source } as any,
      create: { canonicalItemId, aliasText: text, householdId, vendor, source } as any,
    });

    await audit({
      actorType: "USER",
      actorId: req.user?.id ?? null,
      action: before ? "ITEM_ALIAS_UPDATED" : "ITEM_ALIAS_CREATED",
      entityType: "ItemAlias",
      entityId: alias.id,
      householdId: householdId ?? null,
      before: before ?? null,
      after: alias,
      req,
    });

    return res.status(before ? 200 : 201).json(alias);
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});


app.post("/v1/inventory/lots/from-normalized", requireVoraviaJwt, async (req, res) => {
  try {
    const ctx = await prisma.$transaction((tx) => requireOwner(tx, req));
    const { normalizedLineItemId, locationCode, expiresAt, currency } = req.body ?? {};
    const requestId = requireRequestId(req);

    if (!normalizedLineItemId) {
      return res.status(400).json({ error: "normalizedLineItemId is required" });
    }

    const nli = await prisma.normalizedLineItem.findFirst({
      where: { id: String(normalizedLineItemId), householdId: ctx.householdId, deletedAt: null },
    });
    if (!nli) return res.status(404).json({ error: "NormalizedLineItem not found" });

    if (nli.decisionStatus !== "APPROVED") {
      return res.status(400).json({ error: "NormalizedLineItem must be APPROVED" });
    }

    const canonicalItemId = nli.finalCanonicalItemId;
    if (!canonicalItemId) {
      return res.status(400).json({ error: "NormalizedLineItem missing finalCanonicalItemId" });
    }

    // Units (LOCKED): grams base; volume unresolved
    const qtyInitial = nli.quantityGrams ?? nli.quantityEach;
    const unitCode = nli.quantityGrams ? "g" : nli.quantityEach ? "each" : null;

    if (!qtyInitial || !unitCode) {
      return res.status(400).json({
        error: "Cannot create lot: quantity unresolved (volume/unknown). Approve a line with grams/each.",
      });
    }

    // Idempotency: one lot per normalized line (DB unique recommended)
    const existingLot = await prisma.inventoryLot.findFirst({
      where: { sourceNormalizedLineId: nli.id },
    });
    if (existingLot) {
      return res.json({ ok: true, lot: existingLot, idempotent: true });
    }

    const now = new Date();

    const { lot, idempotent } = await prisma.$transaction(async (tx) => {
      // Reload NLI inside tx if you want, but not required if you treat it as read-only

      // Access guard: caller must be household member of nli.householdId
      const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
      const userId = ctx.userId;
      await assertHouseholdMemberOrThrow(tx, userId, nli.householdId);

      // (1) Request idempotency
      if (requestId) {
        const prior = await findPriorEvent(tx, nli.householdId, String(requestId));
        if (prior?.entityId) {
          const priorLot = await tx.inventoryLot.findFirst({ where: { id: prior.entityId } });
          if (priorLot) return { lot: priorLot, idempotent: true };
        }
      }

      // (2) One lot per normalized line (race-safe inside tx)
      const existing = await tx.inventoryLot.findFirst({
        where: { sourceNormalizedLineId: nli.id },
      });
      if (existing) return { lot: existing, idempotent: true };

      // Pull receipt + raw line to deterministically set purchasedAt, expiresAt, and costTotal
      const receipt = await tx.receiptRaw.findFirst({ where: { id: nli.receiptId, deletedAt: null } });
      //const rlr = await tx.receiptLineRaw.findFirst({ where: { id: nli.receiptLineRawId } });
      const rlr = nli.receiptLineRawId
        ? await tx.receiptLineRaw.findUnique({
          where: { id: nli.receiptLineRawId },
          select: { lineTotal: true, unitPrice: true, originalQuantity: true, rawLineText: true, name: true, description: true },
        })
        : null;


      const canonical = await tx.canonicalItem.findFirst({ where: { id: canonicalItemId } });

      const purchasedAtBase = receipt?.purchaseDate ?? now;

      const classifierText = [
        canonical?.name,
        nli.normalizedText,
        nli.rawDescription,
        rlr?.name,
        rlr?.description,
        rlr?.rawLineText,
      ]
        .filter(Boolean)
        .join(" ");

      const computedExpiresAt = estimateExpiresAtDeterministic({
        baseDate: purchasedAtBase,
        textForClassification: classifierText,
        expiresAtProvided: expiresAt ? new Date(expiresAt) : null,
      });

      // Cost attribution (deterministic): ReceiptLineRaw -> NormalizedLineItem -> null
      let computedCostTotal: Prisma.Decimal | null = null;



      const rlrLineTotal = (rlr as any)?.lineTotal as Prisma.Decimal | null | undefined;
      const rlrUnitPrice = (rlr as any)?.unitPrice as Prisma.Decimal | null | undefined;
      const rlrOrigQty = (rlr as any)?.originalQuantity as Prisma.Decimal | null | undefined;

      if (rlrLineTotal != null) computedCostTotal = rlrLineTotal;
      else if (rlrUnitPrice != null && rlrOrigQty != null) computedCostTotal = rlrUnitPrice.mul(rlrOrigQty);
      else if (nli.lineTotal != null) computedCostTotal = nli.lineTotal;
      else if (nli.unitPrice != null && qtyInitial != null) computedCostTotal = nli.unitPrice.mul(qtyInitial);


      const requestCurrency = (req.body?.currency ?? null) as string | null;

      const computedCurrency =
        requestCurrency ?? receipt?.currency ?? (computedCostTotal ? "USD" : null);

      let finalCostTotal = computedCostTotal;
      let finalCurrency = computedCurrency;


      // FINAL cost/currency resolution:
      // 1) Prefer direct ReceiptLineRaw (FK via nli.receiptLineRawId) already loaded as `rlr`
      // 2) Only if `rlr` is missing (legacy), try a deterministic fallback match within receipt
      // 3) Otherwise keep computedCostTotal (may come from nli) or null

      if (!rlr) {
        const receiptLines = await prisma.receiptLineRaw.findMany({
          where: { receiptId: nli.receiptId },
          select: { id: true, rawLineText: true, lineTotal: true },
        });

        const needle = (nli.rawDescription || nli.normalizedText || "")
          .toLowerCase()
          .trim();

        if (needle) {
          const matches = receiptLines.filter((rl) =>
            (rl.rawLineText || "").toLowerCase().includes(needle)
          );

          // Only accept if exactly one match (trust-first)
          if (matches.length === 1 && matches[0].lineTotal != null) {
            finalCostTotal = matches[0].lineTotal;
            finalCurrency = computedCurrency;
          }
        }
      }

      try {
        const lot = await tx.inventoryLot.create({
          data: {
            householdId: nli.householdId,
            canonicalItemId,
            sourceReceiptId: nli.receiptId,
            sourceNormalizedLineId: nli.id,
            unitCode,
            quantityInitial: qtyInitial,
            quantityRemaining: qtyInitial,
            locationCode: locationCode ?? "PANTRY",
            purchasedAt: purchasedAtBase,
            expiresAt: computedExpiresAt,
            currency: finalCurrency,
            costTotal: finalCostTotal,
          },
        });
        await tx.inventoryEvent.create({
          data: {
            householdId: lot.householdId,
            type: "LOT_CREATED",
            actorUserId: userId,
            entityType: "LOT",
            entityId: lot.id,
            requestId,
            payload: {
              normalizedLineItemId: nli.id,
              createdAt: new Date().toISOString(),
            },
          },
        });

        return { lot, idempotent: false };
      } catch (e: any) {
        // If unique violation happened due to a race, return the existing lot
        // P2002 = Prisma unique constraint violation
        if (e?.code === "P2002") {
          const existingAfter = await tx.inventoryLot.findFirst({
            where: { sourceNormalizedLineId: nli.id },
          });
          if (existingAfter) return { lot: existingAfter, idempotent: true };
        }
        throw e;
      }
    });


    await audit({
      actorType: "USER",
      actorId: req.user?.id ?? null,
      action: "INVENTORY_LOT_CREATED_FROM_NORMALIZED",
      entityType: "InventoryLot",
      entityId: lot.id,
      householdId: lot.householdId,
      after: lot,
      req,
    });

    return res.status(201).json({ ok: true, lot, idempotent });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});


app.post("/v1/inventory/lots/:id/consume", requireVoraviaJwt, async (req, res) => {
  try {
    const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
    const userId = ctx.userId;
    const lotId = String(req.params.id);
    const requestId = requireRequestId(req); // Phase-1 rule: required for mutations

    const { quantityGrams, quantityEach, reason } = req.body ?? {};

    const hasGrams = quantityGrams !== undefined && quantityGrams !== null;
    const hasEach = quantityEach !== undefined && quantityEach !== null;

    if (!hasGrams && !hasEach) {
      return res.status(400).json({ error: "quantityGrams or quantityEach is required" });
    }
    if (hasGrams && hasEach) {
      return res.status(400).json({ error: "Provide only one: quantityGrams OR quantityEach" });
    }

    const expectedUnit = hasGrams ? "g" : "each";
    const qty = parseDecimalStrict(hasGrams ? quantityGrams : quantityEach, "quantity");

    const result = await prisma.$transaction(async (tx) => {
      // Load lot (no cross-household trust)
      const lot = await tx.inventoryLot.findFirst({
        where: { id: lotId, householdId: ctx.householdId },
      });
      if (!lot) throw Object.assign(new Error("InventoryLot not found"), { status: 404 });
      // Idempotency: if event exists, return current lot (no double mutation)
      const prior = await findPriorEvent(tx, lot.householdId, requestId);
      if (prior?.entityId) {
        const currentLot = await tx.inventoryLot.findFirst({ where: { id: prior.entityId } });
        if (currentLot) return { lot: currentLot, idempotent: true };
        // Fallback: return loaded lot
        return { lot, idempotent: true };
      }

      // Unit guardrail
      if (lot.unitCode !== expectedUnit) {
        throw Object.assign(
          new Error(`UNIT_MISMATCH: lot=${lot.unitCode} attempt=${expectedUnit}`),
          { status: 400 }
        );
      }

      // Decimal-safe checks and decrement
      const remaining = new Prisma.Decimal(lot.quantityRemaining as any);
      if (qty.gt(remaining)) {
        throw Object.assign(new Error("INSUFFICIENT_REMAINING"), { status: 400 });
      }

      // Atomic guard: only update if remaining >= qty (Decimal safe)
      const updated = await tx.inventoryLot.updateMany({
        where: {
          id: lot.id,
          quantityRemaining: { gte: qty },
        },
        data: {
          quantityRemaining: { decrement: qty },
        },
      });

      if (updated.count !== 1) {
        throw Object.assign(new Error("INSUFFICIENT_REMAINING"), { status: 400 });
      }

      const updatedLot = await tx.inventoryLot.findUnique({ where: { id: lot.id } });
      if (!updatedLot) throw Object.assign(new Error("InventoryLot not found after update"), { status: 404 });

      // Exactly one InventoryEvent, with requestId column set
      await tx.inventoryEvent.create({
        data: {
          householdId: updatedLot.householdId,
          type: "LOT_CONSUMED" as any,
          actorUserId: userId,
          entityType: "LOT",
          entityId: updatedLot.id,
          requestId, // ✅ critical fix
          payload: {
            reason: reason ?? null,

            lotId: updatedLot.id,
            canonicalItemId: updatedLot.canonicalItemId,
            unitCode: updatedLot.unitCode,

            quantityConsumed: qty.toString(),
            quantityRemainingBefore: remaining.toString(),
            quantityRemainingAfter: (updatedLot.quantityRemaining as any)?.toString?.() ?? String(updatedLot.quantityRemaining),

            sourceReceiptId: updatedLot.sourceReceiptId ?? null,
            sourceNormalizedLineId: updatedLot.sourceNormalizedLineId ?? null,

            consumedAt: new Date().toISOString(),
          },
        },
      });

      return { lot: updatedLot, idempotent: false };
    });

    // Audit outside tx is ok (Phase-1 allowed). No duplicate InventoryEvent writes.
    await audit({
      actorType: "USER",
      actorId: req.user?.id ?? null,
      action: "INVENTORY_LOT_CONSUMED",
      entityType: "InventoryLot",
      entityId: result.lot.id,
      householdId: result.lot.householdId,
      before: null,
      after: result.lot,
      reason: req.body?.reason ?? null,
      req,
    });

    return res.status(200).json({ ok: true, lot: result.lot, idempotent: result.idempotent });
  } catch (e: any) {
    return sendSafeError(res, e);
  }
});


app.get("/v1/inventory/summary", requireVoraviaJwt, async (req, res) => {
  try {
    const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
    const userId = ctx.userId;
    const householdId = ctx.householdId;
    const days = Number(req.query.days ?? 7);


    const now = new Date();
    const soon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // Keep it simple now: fetch active lots (remaining > 0, not soft-deleted if you add deletedAt later)
    const lots = await prisma.inventoryLot.findMany({
      where: {
        householdId,
        quantityRemaining: { gt: 0 },
      },
      include: {
        canonicalItem: true,
      },
      orderBy: [{ expiresAt: "asc" }],
    });

    let gramsRemaining = 0;
    let eachRemaining = 0;

    const byLocation: Record<string, { lots: number; grams: number; each: number }> = {};
    const byItem: Record<
      string,
      { canonicalItemId: string; name: string; vendor: string | null; lots: number; grams: number; each: number; soonestExpiry: Date | null }
    > = {};

    let expiringSoonCount = 0;
    let expiredCount = 0;

    for (const lot of lots) {
      const loc = lot.locationCode ?? "UNSPECIFIED";
      if (!byLocation[loc]) byLocation[loc] = { lots: 0, grams: 0, each: 0 };
      byLocation[loc].lots += 1;

      const rem = Number(lot.quantityRemaining);
      if (lot.unitCode === "g") {
        gramsRemaining += rem;
        byLocation[loc].grams += rem;
      } else if (lot.unitCode === "each") {
        eachRemaining += rem;
        byLocation[loc].each += rem;
      }

      // expiry buckets
      if (lot.expiresAt) {
        if (lot.expiresAt < now) expiredCount += 1;
        else if (lot.expiresAt <= soon) expiringSoonCount += 1;
      }

      // per canonical item
      const cid = lot.canonicalItemId;
      const name = lot.canonicalItem?.name ?? "Unknown";
      const vendor = (lot.canonicalItem as any)?.vendor ?? null;

      if (!byItem[cid]) {
        byItem[cid] = { canonicalItemId: cid, name, vendor, lots: 0, grams: 0, each: 0, soonestExpiry: null };
      }

      byItem[cid].lots += 1;
      if (lot.unitCode === "g") byItem[cid].grams += rem;
      if (lot.unitCode === "each") byItem[cid].each += rem;

      if (lot.expiresAt) {
        const prev = byItem[cid].soonestExpiry;
        if (!prev || lot.expiresAt < prev) byItem[cid].soonestExpiry = lot.expiresAt;
      }
    }

    const topItems = Object.values(byItem)
      .sort((a, b) => (b.grams + b.each) - (a.grams + a.each))
      .slice(0, 25);

    return res.json({
      householdId,
      asOf: now.toISOString(),
      totals: {
        lots: lots.length,
        distinctItems: Object.keys(byItem).length,
        gramsRemaining,
        eachRemaining,
      },
      expiry: {
        daysWindow: days,
        expiringSoonCount,
        expiredCount,
      },
      byLocation,
      topItems,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});

app.post("/v1/inventory/lots/:id/adjust", requireVoraviaJwt, async (req, res) => {
  try {
    const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
    const userId = ctx.userId;
    const lotId = String(req.params.id);
    const requestId = requireRequestId(req); // Phase-1 rule

    const { setRemaining, delta, reason } = req.body ?? {};

    const hasSet = setRemaining !== undefined && setRemaining !== null;
    const hasDelta = delta !== undefined && delta !== null;

    if (!hasSet && !hasDelta) return res.status(400).json({ error: "Provide setRemaining OR delta" });
    if (hasSet && hasDelta) return res.status(400).json({ error: "Provide only one: setRemaining OR delta" });

    const result = await prisma.$transaction(async (tx) => {
      const lot = await tx.inventoryLot.findFirst({ where: { id: lotId, householdId: ctx.householdId } });
      if (!lot) throw Object.assign(new Error("InventoryLot not found"), { status: 404 });

      // Idempotency
      const prior = await findPriorEvent(tx, lot.householdId, requestId);
      if (prior?.entityId) {
        const priorLot = await tx.inventoryLot.findFirst({ where: { id: prior.entityId } });
        if (priorLot) return { lot: priorLot, idempotent: true };
        return { lot, idempotent: true };
      }

      const beforeRemaining = new Prisma.Decimal(lot.quantityRemaining as any);

      let afterRemaining: Prisma.Decimal;
      if (hasSet) {
        // allow setRemaining = 0? Your rule says cannot be negative; 0 is valid for "consumed all"
        const s = typeof setRemaining === "string" ? setRemaining.trim() : String(setRemaining);
        afterRemaining = new Prisma.Decimal(s);
        if (!afterRemaining.isFinite() || afterRemaining.lt(0)) {
          throw Object.assign(new Error("INVALID_REMAINING"), { status: 400 });
        }
      } else {
        // delta can be positive or negative; but result must be >= 0
        const d = new Prisma.Decimal(typeof delta === "string" ? delta.trim() : String(delta));
        if (!d.isFinite()) throw Object.assign(new Error("INVALID_DELTA"), { status: 400 });
        afterRemaining = beforeRemaining.plus(d);
        if (afterRemaining.lt(0)) throw Object.assign(new Error("INVALID_REMAINING"), { status: 400 });
      }

      const updated = await tx.inventoryLot.update({
        where: { id: lot.id },
        data: { quantityRemaining: afterRemaining },
      });

      await tx.inventoryEvent.create({
        data: {
          householdId: updated.householdId,
          type: "LOT_ADJUSTED",
          actorUserId: userId,
          entityType: "LOT",
          entityId: updated.id,
          requestId, // ✅ required and set
          payload: {
            reason: reason ?? null,
            mode: hasSet ? "SET_REMAINING" : "DELTA",
            unitCode: updated.unitCode,
            quantityRemainingBefore: beforeRemaining.toString(),
            quantityRemainingAfter: afterRemaining.toString(),
            delta: hasSet ? afterRemaining.minus(beforeRemaining).toString() : String(delta),
            adjustedAt: new Date().toISOString(),
          },
        },
      });

      return { lot: updated, idempotent: false };
    });

    await audit({
      actorType: "USER",
      actorId: req.user?.id ?? null,
      action: "INVENTORY_LOT_ADJUSTED",
      entityType: "InventoryLot",
      entityId: result.lot.id,
      householdId: result.lot.householdId,
      before: null,
      after: result.lot,
      reason: req.body?.reason ?? null,
      req,
    });

    return res.json({ ok: true, lot: result.lot, idempotent: result.idempotent });
  } catch (e: any) {
    return sendSafeError(res, e);
  }
});



app.get("/v1/inventory/forecast", requireVoraviaJwt, async (req, res) => {
  try {
    const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
    const userId = ctx.userId;
    const householdId = ctx.householdId;
    const windowDays = Number(req.query.windowDays ?? 14);

    if (!householdId) return res.status(400).json({ error: "householdId is required" });


    if (!Number.isFinite(windowDays) || windowDays <= 0) return res.status(400).json({ error: "windowDays must be > 0" });

    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    // Active lots
    const lots = await prisma.inventoryLot.findMany({
      where: { householdId, quantityRemaining: { gt: 0 } },
      include: { canonicalItem: true },
      orderBy: [{ expiresAt: "asc" }],
    });

    // Consumption events in window
    const events = await prisma.inventoryEvent.findMany({
      where: { householdId, type: "LOT_CONSUMED", createdAt: { gte: windowStart } },
      select: { payload: true },
    });

    // Sum consumed by canonicalItemId and unitCode
    const consumed: Record<string, { grams: number; each: number; eventsUsed: number }> = {};

    for (const e of events) {
      const p: any = e.payload ?? {};
      const cid = String(p.canonicalItemId ?? "");
      const unit = String(p.unitCode ?? "");
      const qty = Number(p.quantityConsumed ?? 0);

      if (!cid || !Number.isFinite(qty) || qty <= 0) continue;
      if (!consumed[cid]) consumed[cid] = { grams: 0, each: 0, eventsUsed: 0 };

      if (unit === "g") consumed[cid].grams += qty;
      else if (unit === "each") consumed[cid].each += qty;
      consumed[cid].eventsUsed += 1;
    }

    // Remaining by item
    const byItem: Record<
      string,
      {
        canonicalItemId: string;
        name: string;
        vendor: string | null;
        gramsRemaining: number;
        eachRemaining: number;
        soonestExpiry: Date | null;
        lots: number;
      }
    > = {};

    for (const lot of lots) {
      const cid = lot.canonicalItemId;
      if (!byItem[cid]) {
        byItem[cid] = {
          canonicalItemId: cid,
          name: lot.canonicalItem?.name ?? "Unknown",
          vendor: (lot.canonicalItem as any)?.vendor ?? null,
          gramsRemaining: 0,
          eachRemaining: 0,
          soonestExpiry: null,
          lots: 0,
        };
      }

      byItem[cid].lots += 1;

      const rem = Number(lot.quantityRemaining);
      if (lot.unitCode === "g") byItem[cid].gramsRemaining += rem;
      if (lot.unitCode === "each") byItem[cid].eachRemaining += rem;

      if (lot.expiresAt) {
        const prev = byItem[cid].soonestExpiry;
        if (!prev || lot.expiresAt < prev) byItem[cid].soonestExpiry = lot.expiresAt;
      }
    }

    const items = Object.values(byItem).map((i) => {
      const c = consumed[i.canonicalItemId] ?? { grams: 0, each: 0, eventsUsed: 0 };
      const gramsPerDay = c.grams / windowDays;
      const eachPerDay = c.each / windowDays;

      const gramsDaysLeft = gramsPerDay > 0 ? i.gramsRemaining / gramsPerDay : null;
      const eachDaysLeft = eachPerDay > 0 ? i.eachRemaining / eachPerDay : null;

      const projectedDepleteAtGrams =
        gramsDaysLeft !== null ? new Date(now.getTime() + gramsDaysLeft * 24 * 60 * 60 * 1000).toISOString() : null;

      const projectedDepleteAtEach =
        eachDaysLeft !== null ? new Date(now.getTime() + eachDaysLeft * 24 * 60 * 60 * 1000).toISOString() : null;

      // Risk: expires before projected depletion? (basic heuristic)
      const expiryISO = i.soonestExpiry ? i.soonestExpiry.toISOString() : null;

      return {
        canonicalItemId: i.canonicalItemId,
        name: i.name,
        vendor: i.vendor,
        gramsRemaining: i.gramsRemaining,
        eachRemaining: i.eachRemaining,
        gramsConsumed: c.grams,
        eachConsumed: c.each,
        gramsPerDay,
        eachPerDay,
        gramsDaysLeft,
        eachDaysLeft,
        projectedDepleteAtGrams,
        projectedDepleteAtEach,
        soonestExpiry: expiryISO,
        lots: i.lots,
        eventsUsed: c.eventsUsed,
      };
    });

    // Sort: most “at risk” first (expiry soon, or high burn)
    items.sort((a, b) => {
      const aExp = a.soonestExpiry ? Date.parse(a.soonestExpiry) : Infinity;
      const bExp = b.soonestExpiry ? Date.parse(b.soonestExpiry) : Infinity;
      return aExp - bExp;
    });

    return res.json({
      householdId,
      asOf: now.toISOString(),
      windowDays,
      windowStart: windowStart.toISOString(),
      totals: { activeLots: lots.length, distinctItems: items.length, eventsUsed: events.length },
      items,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Unknown error" });
  }
});


app.get(
  "/v1/assistant/actions",
  requireVoraviaJwt,
  async (req, res) => {
    try {
      const ctx = await prisma.$transaction((tx) => requireMember(tx, req));
      const userId = ctx.userId;
      const householdId = ctx.householdId;
      //const userId = req.userId;


      const result: any = await generateAssistantActions(
        prisma,
        householdId
      );

      // Backward compatible: older engines returned an array
      if (Array.isArray(result)) return res.json({ actions: result });

      return res.json(result);
    } catch (err) {
      sendSafeError(res, err);
    }
  }
);

// ✅ keep listen at bottom (routes registered first)
app.listen(port, () => console.log(`cHaif running on port ${port}`));
