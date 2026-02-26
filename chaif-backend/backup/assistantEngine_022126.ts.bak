import { PrismaClient, Prisma, $Enums } from "@prisma/client";
import { computeExpiryRiskAction, compareDueBy, severityRank } from "./expiryRules";

type Config = {
  lookbackDays: number;
  minCoverageDays: number;
  targetCoverageDays: number;
  maxActions: number;
};

const DEFAULT_CONFIG: Config = {
  lookbackDays: 14,
  minCoverageDays: 3,
  targetCoverageDays: 7,
  maxActions: 3,
};

type AssistantAction = {
  type: "RUNOUT_RISK" | "EXPIRY_RISK";
  severity: "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  title: string;
  why: string;
  dueBy: Date | null;
  canonicalItemId: string;
  recommendedNextStep?: string;
};

function compareActions(a: AssistantAction, b: AssistantAction): number {
  // severity desc
  const sev = severityRank(b.severity) - severityRank(a.severity);
  if (sev !== 0) return sev;

  // earliest dueBy first (null last)
  const due = compareDueBy(a.dueBy, b.dueBy);
  if (due !== 0) return due;

  // confidence desc
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;

  // stable tie-breaker
  return (a.canonicalItemId + a.type).localeCompare(b.canonicalItemId + b.type);
}

function pickMoreUrgent(a: AssistantAction, b: AssistantAction): AssistantAction {
  // Prefer earlier dueBy; if tie, higher severity; if tie, higher confidence.
  const due = compareDueBy(a.dueBy, b.dueBy);
  if (due !== 0) return due < 0 ? a : b;

  const sev = severityRank(a.severity) - severityRank(b.severity);
  if (sev !== 0) return sev > 0 ? a : b;

  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;

  // deterministic fallback
  return a.type <= b.type ? a : b;
}

export async function generateAssistantActions(
  prisma: PrismaClient,
  householdId: string,
  config?: Partial<Config>
): Promise<{ actions: AssistantAction[] }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date();
  const lookbackDate = new Date();
  lookbackDate.setDate(now.getDate() - cfg.lookbackDays);

  // 1) Fetch lots
  const lots = await prisma.inventoryLot.findMany({
    where: { householdId },
    include: { canonicalItem: true },
  });

  if (lots.length === 0) {
    return {
      actions: [
        {
          type: "RUNOUT_RISK",
          severity: "LOW",
          confidence: 0.6,
          title: "Add your first receipt",
          why: "No inventory yet — once you add items, I’ll pre-plan usage to prevent waste and runouts.",
          dueBy: null,
          canonicalItemId: "SETUP",
          recommendedNextStep: "Scan a receipt to start planning.",
        },
      ],
    };
  }

  // 2) Fetch consumption events in window
  const events = await prisma.inventoryEvent.findMany({
    where: {
      householdId,
      type: $Enums.InventoryEventType.LOT_CONSUMED,
      createdAt: { gte: lookbackDate },
    },
    orderBy: { createdAt: "asc" },
  });

  // Aggregate consumption by canonicalItemId (total + firstAt + count)
  const consumption = new Map<
    string,
    { total: Prisma.Decimal; firstAt: Date; count: number }
  >();

  for (const event of events) {
    const payload: any = event.payload;
    const canonicalItemId: string | undefined = payload?.canonicalItemId;
    const quantityConsumed = new Prisma.Decimal(payload?.quantityConsumed || 0);
    if (!canonicalItemId || quantityConsumed.lte(0)) continue;

    const prev = consumption.get(canonicalItemId);
    if (!prev) {
      consumption.set(canonicalItemId, {
        total: quantityConsumed,
        firstAt: event.createdAt,
        count: 1,
      });
    } else {
      prev.total = prev.total.plus(quantityConsumed);
      prev.count += 1;
    }
  }

  // Aggregate lots by canonicalItemId (total remaining + earliest expiry)
  const lotAgg = new Map<
    string,
    {
      name: string;
      unitCode: string | null;
      totalRemaining: Prisma.Decimal;
      earliestExpiresAt: Date | null;
    }
  >();

  for (const lot of lots) {
    const key = lot.canonicalItemId;
    const name = lot.canonicalItem?.name ?? "Item";
    const existing = lotAgg.get(key);

    const expiresAt = lot.expiresAt ?? null;
    if (!existing) {
      lotAgg.set(key, {
        name,
        unitCode: lot.unitCode ?? null,
        totalRemaining: lot.quantityRemaining,
        earliestExpiresAt: expiresAt,
      });
    } else {
      existing.totalRemaining = existing.totalRemaining.plus(lot.quantityRemaining);
      // earliest expiry wins
      if (expiresAt) {
        if (!existing.earliestExpiresAt || expiresAt.getTime() < existing.earliestExpiresAt.getTime()) {
          existing.earliestExpiresAt = expiresAt;
        }
      }
    }
  }

  // Build candidate actions per item
  const candidatesByItem = new Map<string, AssistantAction[]>();

  for (const [canonicalItemId, agg] of lotAgg.entries()) {
    const consumed = consumption.get(canonicalItemId);
    const totalConsumed = consumed?.total ?? new Prisma.Decimal(0);

    // Avg daily use:
    // - If there is consumption, use days since first use (min 1 day) for stability.
    // - Otherwise, avgDailyUse=0 => no depletion action.
    let avgDailyUse = new Prisma.Decimal(0);
    if (consumed && totalConsumed.gt(0)) {
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSinceFirstUse = Math.max(
        1,
        Math.ceil((now.getTime() - consumed.firstAt.getTime()) / msPerDay)
      );
      avgDailyUse = totalConsumed.dividedBy(daysSinceFirstUse);
    }

    // RUNOUT_RISK (deterministic)
    if (avgDailyUse.gt(0)) {
      const coverageDays = agg.totalRemaining.dividedBy(avgDailyUse);

      if (coverageDays.lt(cfg.minCoverageDays)) {
        let severity: "HIGH" | "MEDIUM" | "LOW" = "LOW";
        if (coverageDays.lte(2)) severity = "HIGH";
        else if (coverageDays.lte(5)) severity = "MEDIUM";

        // confidence by event count (deterministic)
        const count = consumed?.count ?? 0;
        let confidence = 0.6;
        if (count >= 2) confidence = 0.8;
        if (count >= 4) confidence = 0.9;

        const dueDate = new Date(now);
        const coverageNumber = Math.max(1, Math.floor(coverageDays.toNumber()));
        dueDate.setDate(now.getDate() + coverageNumber);

        const action: AssistantAction = {
          type: "RUNOUT_RISK",
          severity,
          confidence,
          title: `${agg.name} will run out in ~${coverageDays.toDecimalPlaces(1)} days`,
          why: `${agg.totalRemaining.toString()} ${agg.unitCode ?? ""} remaining; recent use ~${avgDailyUse.toDecimalPlaces(1)} ${agg.unitCode ?? ""}/day`,
          dueBy: dueDate,
          canonicalItemId,
          recommendedNextStep: "Add to next grocery run or adjust meal plan.",
        };

        const arr = candidatesByItem.get(canonicalItemId) ?? [];
        arr.push(action);
        candidatesByItem.set(canonicalItemId, arr);
      }
    }

    // EXPIRY_RISK (deterministic)
    const expiryAction = computeExpiryRiskAction({
      canonicalItemId,
      itemName: agg.name,
      expiresAt: agg.earliestExpiresAt,
      now,
    });

    if (expiryAction) {
      const arr = candidatesByItem.get(canonicalItemId) ?? [];
      arr.push(expiryAction);
      candidatesByItem.set(canonicalItemId, arr);
    }
  }

  // Pressure classifier: max 1 action per canonicalItemId
  const selected: AssistantAction[] = [];

  for (const [canonicalItemId, acts] of candidatesByItem.entries()) {
    if (acts.length === 1) {
      selected.push(acts[0]);
      continue;
    }
    // choose more urgent between runout + expiry
    let best = acts[0];
    for (let i = 1; i < acts.length; i++) {
      best = pickMoreUrgent(best, acts[i]);
    }
    selected.push(best);
  }

  selected.sort(compareActions);

  return { actions: selected.slice(0, cfg.maxActions) };
}
