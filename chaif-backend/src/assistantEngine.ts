import { PrismaClient, Prisma, $Enums } from "@prisma/client";
import { computeExpiryRiskAction, severityRank, compareDueBy } from "./expiryRules";

type Severity = "HIGH" | "MEDIUM" | "LOW";
type ActionType = "RUNOUT_RISK" | "EXPIRY_RISK";

const EXPIRY_HORIZON_DAYS = Number(process.env.EXPIRY_HORIZON_DAYS ?? 14);

export type AssistantAction = {
  type: ActionType;
  severity: Severity;
  confidence: number; // 0..1
  title: string;
  why: string;
  dueBy: Date | null;
  canonicalItemId: string;
  recommendedNextStep?: string;
};

type WasteExposure = {
  horizonDays: number;
  score: number; // 0..100
  band: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  dollarsAtRisk: null | {
    amount: number;
    currency: string;
    coveragePct: number;
  };
  topDrivers: Array<{
    canonicalItemId: string;
    label: string;
    expiresAt: string | null;
    riskPoints: number;
    dollarsAtRisk: number | null;
  }>;
};

type Config = {
  lookbackDays: number;
  minCoverageDays: number;
  maxActions: number;
  wasteHorizonDays: number;
};

const DEFAULT_CONFIG: Config = {
  lookbackDays: 14,
  minCoverageDays: 3,
  maxActions: 3,
  wasteHorizonDays: 14,
};



function daysBetweenCeil(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function bandFromScore(score: number): WasteExposure["band"] {
  if (score >= 80) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 20) return "MEDIUM";
  return "LOW";
}

function wasteBasePoints(daysToExpiry: number): number {
  if (daysToExpiry <= 0) return 30;
  if (daysToExpiry <= 2) return 20;
  if (daysToExpiry <= 5) return 12;
  if (daysToExpiry <= 10) return 6;
  if (daysToExpiry <= 14) return 2;
  return 0;
}

function wasteProbability(daysToExpiry: number): number {
  if (daysToExpiry <= 0) return 0.95;
  if (daysToExpiry <= 2) return 0.7;
  if (daysToExpiry <= 5) return 0.4;
  if (daysToExpiry <= 10) return 0.2;
  if (daysToExpiry <= 14) return 0.1;
  return 0;
}

function qtyMultiplier(qtyRemaining: number): number {
  if (qtyRemaining >= 1000) return 1.5;
  if (qtyRemaining >= 500) return 1.3;
  if (qtyRemaining >= 250) return 1.15;
  return 1.0;
}



export async function generateAssistantActions(
  prisma: PrismaClient,
  householdId: string,
  config?: Partial<Config>
): Promise<{ actions: AssistantAction[]; wasteExposure: WasteExposure }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date();

  const lookbackDate = new Date(now);
  lookbackDate.setDate(now.getDate() - cfg.lookbackDays);

  // Lots + canonical labels
  //const now = new Date();
  const horizon = new Date(now.getTime() + EXPIRY_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  // Only load lots that can generate expiry risk (bounded by horizon)
  let candidateLots = await prisma.inventoryLot.findMany({
    where: {
      householdId,
      quantityRemaining: { gt: new Prisma.Decimal(0) }, // Decimal-safe
      expiresAt: { not: null, lte: horizon },
    },
    orderBy: { expiresAt: "asc" },
    take: 2000,
    // NOTE: no "take" here to keep behavior identical within horizon.
    // If you want a guardrail later, add take: 2000 (but that can change behavior in extreme cases).
    select: {
      id: true,
      canonicalItemId: true,
      expiresAt: true,
      quantityInitial: true,
      quantityRemaining: true,
      costTotal: true,
      currency: true,
      canonicalItem: { select: { name: true } },
    },
  });


  // Safety fallback: if nothing is inside horizon, still show *something*
  // (preserves UX — "no actions" when inventory exists feels broken)
  if (candidateLots.length === 0) {
    candidateLots = await prisma.inventoryLot.findMany({
      where: {
        householdId,
        quantityRemaining: { gt: new Prisma.Decimal(0) },
        expiresAt: { not: null },
      },
      orderBy: { expiresAt: "asc" },
      take: 50,
      select: {
        id: true,
        canonicalItemId: true,
        expiresAt: true,
        quantityInitial: true,
        quantityRemaining: true,
        costTotal: true,
        currency: true,
        canonicalItem: { select: { name: true } },
      },
    });
  }

  const lots = candidateLots;

  // Consumption events for runout projection
  const events = await prisma.inventoryEvent.findMany({
    where: {
      householdId,
      type: $Enums.InventoryEventType.LOT_CONSUMED,
      createdAt: { gte: lookbackDate },
    },
    orderBy: { createdAt: "asc" },
  });

  if (lots.length === 0) {
    return {
      actions: ([
        {
          type: "RUNOUT_RISK",
          severity: "LOW",
          confidence: 0.4,
          title: "Add your first receipt",
          why: "No inventory yet — once you add items, I’ll pre-plan usage to prevent waste and runouts.",
          dueBy: null,
          canonicalItemId: "SETUP",
          recommendedNextStep: "Scan your first receipt.",
        },
      ] as AssistantAction[]).slice(0, cfg.maxActions),
      wasteExposure: {
        horizonDays: cfg.wasteHorizonDays,
        score: 0,
        band: "LOW",
        dollarsAtRisk: null,
        topDrivers: [],
      },
    };
  }

  // ---- RUNOUT projection (deterministic) ----
  // Aggregate consumption per canonicalItemId
  const aggMap = new Map<string, { total: Prisma.Decimal; firstAt: Date; eventCount: number }>();

  for (const event of events) {
    const payload: any = event.payload;
    const canonicalItemId = payload?.canonicalItemId;
    const quantityConsumed = new Prisma.Decimal(payload?.quantityConsumed || 0);
    if (!canonicalItemId) continue;

    const prev = aggMap.get(canonicalItemId);
    if (!prev) {
      aggMap.set(canonicalItemId, { total: quantityConsumed, firstAt: event.createdAt, eventCount: 1 });
    } else {
      prev.total = prev.total.plus(quantityConsumed);
      prev.eventCount += 1;
    }
  }

  // Build runout actions by canonicalItemId (use total remaining across lots)
  const remainingByItem = new Map<string, Prisma.Decimal>();
  const labelByItem = new Map<string, string>();

  // Keep labels (cheap) from the limited candidateLots set
  for (const lot of candidateLots) {
    labelByItem.set(lot.canonicalItemId, lot.canonicalItem?.name ?? "Item");
  }

  // Move numeric aggregation to DB (fast)
  const grouped = await prisma.inventoryLot.groupBy({
    by: ["canonicalItemId"],
    where: {
      householdId,
      quantityRemaining: { gt: new Prisma.Decimal(0) },
      expiresAt: { not: null, lte: horizon },
    },
    _sum: { quantityRemaining: true },
  });

  // Rebuild remainingByItem map from DB sums
  for (const g of grouped) {
    const sum = g._sum.quantityRemaining ?? new Prisma.Decimal(0);
    remainingByItem.set(g.canonicalItemId, sum);
  }

  const runoutActions = new Map<string, AssistantAction>();

  for (const [canonicalItemId, remainingQty] of remainingByItem.entries()) {
    const agg = aggMap.get(canonicalItemId);
    if (!agg || agg.total.lte(0)) continue;

    const daysSinceFirstUse = Math.max(
      1,
      daysBetweenCeil(agg.firstAt, now)
    );

    const avgDailyUse = agg.total.dividedBy(daysSinceFirstUse);
    if (avgDailyUse.lte(0)) continue;

    const coverageDays = remainingQty.dividedBy(avgDailyUse);
    if (!coverageDays || coverageDays.lte(0)) continue;

    if (coverageDays.gte(cfg.minCoverageDays)) continue;

    const covNum = coverageDays.toNumber();

    let severity: Severity = "LOW";
    if (covNum <= 2) severity = "HIGH";
    else if (covNum <= 5) severity = "MEDIUM";

    let confidence = 0.6;
    if (agg.eventCount >= 2) confidence = 0.8;
    if (agg.eventCount >= 4) confidence = 0.9;

    const dueBy = new Date(now);
    dueBy.setDate(now.getDate() + Math.max(1, Math.floor(covNum)));

    const label = labelByItem.get(canonicalItemId) ?? "Item";
    runoutActions.set(canonicalItemId, {
      type: "RUNOUT_RISK",
      severity,
      confidence,
      title: `${label} will run out in ~${coverageDays.toDecimalPlaces(1)} days`,
      why: `${remainingQty.toString()} remaining; recent use ~${avgDailyUse.toDecimalPlaces(1)} /day`,
      dueBy,
      canonicalItemId,
      recommendedNextStep: "Add to next grocery run or adjust meal plan.",
    });
  }

  // ---- EXPIRY risk (deterministic) ----
// ---- EXPIRY risk (deterministic, commercial-safe) ----
// DB computes MIN(expiresAt) per canonicalItemId so we don’t loop all lots in Node.
const expiryActionByItem = new Map<string, AssistantAction>();

const expiryAgg = await prisma.inventoryLot.groupBy({
  by: ["canonicalItemId"],
  where: {
    householdId,
    quantityRemaining: { gt: new Prisma.Decimal(0) },
    expiresAt: { not: null, lte: horizon },
  },
  _min: { expiresAt: true },
  orderBy: { _min: { expiresAt: "asc" } }, // earliest first
  take: 2000, // safe headroom; top-3 will always be in earliest expiries
});

for (const row of expiryAgg) {
  const expiresAt = row._min.expiresAt;
  if (!expiresAt) continue;

  const label = labelByItem.get(row.canonicalItemId) ?? "Item";

  const action = computeExpiryRiskAction({
    canonicalItemId: row.canonicalItemId,
    itemName: label,
    expiresAt,
    now,
  });

  if (!action) continue;
  expiryActionByItem.set(row.canonicalItemId, action);
}

  // ---- Pressure classifier (no duplicates) ----
  const merged: AssistantAction[] = [];
  const allItemIds = new Set<string>([
    ...runoutActions.keys(),
    ...expiryActionByItem.keys(),
  ]);

  for (const canonicalItemId of allItemIds) {
    const r = runoutActions.get(canonicalItemId);
    const e = expiryActionByItem.get(canonicalItemId);

    if (r && e) {
      const rDue = r.dueBy?.getTime() ?? Number.POSITIVE_INFINITY;
      const eDue = e.dueBy?.getTime() ?? Number.POSITIVE_INFINITY;

      // choose more urgent: earlier dueBy, else higher severity, else higher confidence
      if (eDue < rDue) merged.push(e);
      else if (rDue < eDue) merged.push(r);
      else {
        const sr = severityRank(r.severity);
        const se = severityRank(e.severity);
        if (se > sr) merged.push(e);
        else if (sr > se) merged.push(r);
        else merged.push((e.confidence >= r.confidence) ? e : r);
      }
    } else if (r) merged.push(r);
    else if (e) merged.push(e);
  }

  // Rank and cap
  merged.sort((a, b) => {
    const s = severityRank(b.severity) - severityRank(a.severity);
    if (s !== 0) return s;

    const d = compareDueBy(a.dueBy, b.dueBy);
    if (d !== 0) return d;

    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const actions = merged.slice(0, cfg.maxActions);

  // ---- Waste Exposure (score + dollars + coverage + drivers) ----
  const horizonEnd = new Date(now);
  horizonEnd.setDate(now.getDate() + cfg.wasteHorizonDays);

  type LotLite = {
    canonicalItemId: string;
    label: string;
    expiresAt: Date | null;
    quantityInitial: Prisma.Decimal;
    quantityRemaining: Prisma.Decimal;
    costTotal: Prisma.Decimal | null;
    currency: string | null;
  };

  const relevantLots: LotLite[] = lots
    .filter((l) => l.quantityRemaining.gt(0) && l.expiresAt && l.expiresAt.getTime() <= horizonEnd.getTime())
    .map((l) => ({
      canonicalItemId: l.canonicalItemId,
      label: l.canonicalItem?.name ?? "Item",
      expiresAt: l.expiresAt ?? null,
      quantityInitial: l.quantityInitial,
      quantityRemaining: l.quantityRemaining,
      costTotal: l.costTotal ?? null,
      currency: l.currency ?? null,
    }));

  let rawPoints = 0;
  let pricedCount = 0;
  let totalCount = relevantLots.length;
  let dollarsSum = 0;

  const driverAgg = new Map<
    string,
    { label: string; expiresAt: Date | null; points: number; dollars: number; priced: boolean }
  >();

  for (const lot of relevantLots) {
    if (!lot.expiresAt) continue;
    const dte = daysBetweenCeil(now, lot.expiresAt);
    const base = wasteBasePoints(dte);
    if (base <= 0) continue;

    const mult = qtyMultiplier(lot.quantityRemaining.toNumber());
    const points = base * mult;
    rawPoints += points;

    // Dollars-at-risk
    let lotDollarsAtRisk: number | null = null;
    const prob = wasteProbability(dte);

    if (lot.costTotal && lot.quantityInitial.gt(0) && prob > 0) {
      const remainingFrac = clamp(
        lot.quantityRemaining.dividedBy(lot.quantityInitial).toNumber(),
        0,
        1
      );
      const remainingValue = lot.costTotal.toNumber() * remainingFrac;
      lotDollarsAtRisk = remainingValue * prob;
      dollarsSum += lotDollarsAtRisk;
      pricedCount += 1;
    }

    const prev = driverAgg.get(lot.canonicalItemId);
    if (!prev) {
      driverAgg.set(lot.canonicalItemId, {
        label: lot.label,
        expiresAt: lot.expiresAt,
        points: points,
        dollars: lotDollarsAtRisk ?? 0,
        priced: lotDollarsAtRisk != null,
      });
    } else {
      // earliest expiry as representative
      if (prev.expiresAt && lot.expiresAt && lot.expiresAt.getTime() < prev.expiresAt.getTime()) {
        prev.expiresAt = lot.expiresAt;
      }
      prev.points += points;
      if (lotDollarsAtRisk != null) {
        prev.dollars += lotDollarsAtRisk;
        prev.priced = true;
      }
    }
  }

  const score = Math.round(100 * (1 - Math.exp(-rawPoints / 60)));
  const band = bandFromScore(score);

  const coveragePct = totalCount === 0 ? 0 : Math.round((pricedCount / totalCount) * 100);

  // Pick currency: if multiple, prefer USD else first non-null
  const currency = relevantLots.find((l) => l.currency)?.currency ?? "USD";

  const topDrivers = Array.from(driverAgg.entries())
    .map(([canonicalItemId, v]) => ({
      canonicalItemId,
      label: v.label,
      expiresAt: v.expiresAt ? v.expiresAt.toISOString() : null,
      riskPoints: Math.round(v.points),
      dollarsAtRisk: v.priced ? Math.round(v.dollars * 100) / 100 : null,
    }))
    .sort((a, b) => {
      // primary sort: dollars if present, else points
      const ad = a.dollarsAtRisk ?? -1;
      const bd = b.dollarsAtRisk ?? -1;
      if (ad !== bd) return bd - ad;
      return b.riskPoints - a.riskPoints;
    })
    .slice(0, 3);

  const dollarsAtRisk =
    pricedCount > 0
      ? { amount: Math.round(dollarsSum * 100) / 100, currency, coveragePct }
      : null;

  return {
    actions,
    wasteExposure: {
      horizonDays: cfg.wasteHorizonDays,
      score,
      band,
      dollarsAtRisk,
      topDrivers,
    },
  };
}
