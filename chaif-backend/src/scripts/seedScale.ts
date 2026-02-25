import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Usage examples:
 *  npx ts-node src/scripts/seedScale.ts --householdId <HH> --actorUserId <USER> --items 200 --lotsPerItem 3 --days 30 --eventsPerItem 10
 *
 * Cleanup:
 *  npx ts-node src/scripts/seedScale.ts --householdId <HH> --purge --prefix SEED_20260222
 */

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// Deterministic-ish pseudo random (fast, seedable)
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const res: T[][] = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

function nowISO() {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv);

  const householdId = String(args.householdId ?? "").trim();
  if (!householdId) throw new Error("Missing --householdId");

  const actorUserId = args.actorUserId ? String(args.actorUserId) : null;

  // Prefix lets you cleanly identify/delete seed data later
  const prefix = String(
    args.prefix ??
      `SEED_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`
  );
  const vendor = String(args.vendor ?? "manual");

  const purge = Boolean(args.purge);

  const items = Number(args.items ?? 200);
  const lotsPerItem = Number(args.lotsPerItem ?? 3);
  const days = Number(args.days ?? 30);
  const eventsPerItem = Number(args.eventsPerItem ?? 10);

  const seed = Number(args.seed ?? 20260222);
  const rand = mulberry32(seed);

  console.log(`[seedScale] ${nowISO()}`);
  console.log(`[seedScale] householdId=${householdId}`);
  console.log(`[seedScale] prefix=${prefix} vendor=${vendor}`);
  console.log(`[seedScale] purge=${purge}`);
  console.log(`[seedScale] items=${items} lotsPerItem=${lotsPerItem} days=${days} eventsPerItem=${eventsPerItem}`);

  if (purge) {
    // Delete tenant-scoped data first (FK constraints)
    const existing = await prisma.canonicalItem.findMany({
      where: { vendor, vendorSku: { startsWith: prefix } },
      select: { id: true },
    });
    const canonicalIds = existing.map((x) => x.id);

    console.log(`[purge] canonicalIds=${canonicalIds.length}`);

    if (canonicalIds.length > 0) {
      await prisma.inventoryLot.deleteMany({
        where: { householdId, canonicalItemId: { in: canonicalIds } },
      });

      // Events: delete only those with requestId starting with prefix to avoid deleting real data
      await prisma.inventoryEvent.deleteMany({
        where: {
          householdId,
          requestId: { startsWith: prefix },
        },
      });

      // Optional: aliases tied to these canonicals (global/tenant)
      await prisma.itemAlias.deleteMany({
        where: { canonicalItemId: { in: canonicalIds } },
      });

      // Canonical items are global — safe to delete only the seeded ones
      await prisma.canonicalItem.deleteMany({
        where: { id: { in: canonicalIds } },
      });
    }

    console.log(`[purge] done`);
    return;
  }

  // 1) Create canonical items (global)
  // Unique constraint is (vendor, vendorSku)
  const canonicalData: Prisma.CanonicalItemCreateManyInput[] = [];
  for (let i = 0; i < items; i++) {
    const sku = `${prefix}_${String(i).padStart(5, "0")}`;
    const name = `Seed Item ${i}`;
    canonicalData.push({
      vendor,
      vendorSku: sku,
      name,
      normalized: name.toLowerCase(),
      description: "seeded for scale test",
      roleCode: null,
      defaultUnitCode: "g",
    });
  }

  // CreateMany in chunks
  for (const part of chunk(canonicalData, 500)) {
    await prisma.canonicalItem.createMany({ data: part, skipDuplicates: true });
  }

  // Fetch canonical IDs back (for FK usage)
  const canonicals = await prisma.canonicalItem.findMany({
    where: { vendor, vendorSku: { startsWith: prefix } },
    select: { id: true, name: true, vendorSku: true },
    orderBy: { vendorSku: "asc" },
  });

  if (canonicals.length === 0) throw new Error("No canonical items created/found; check prefix/vendor");

  console.log(`[seed] canonicalItems=${canonicals.length}`);

  // 2) Create lots (tenant-scoped)
  // InventoryLot fields (from your schema):
  // householdId, canonicalItemId, quantityInitial, quantityRemaining, unitCode, purchasedAt, expiresAt, currency, costTotal
  const lotData: Prisma.InventoryLotCreateManyInput[] = [];
  const msDay = 24 * 60 * 60 * 1000;

  for (const c of canonicals) {
    for (let j = 0; j < lotsPerItem; j++) {
      const qty = Math.floor(500 + rand() * 5000); // 500g..5500g
      const purchasedDaysAgo = Math.floor(rand() * Math.min(days, 60));
      const expiresInDays = Math.floor(1 + rand() * 30); // 1..30 days from purchase
      const purchasedAt = new Date(Date.now() - purchasedDaysAgo * msDay);
      const expiresAt = new Date(purchasedAt.getTime() + expiresInDays * msDay);

      const cost = Number((1 + rand() * 25).toFixed(2)); // $1..$26

      lotData.push({
        householdId,
        canonicalItemId: c.id,
        sourceReceiptId: null,
        sourceNormalizedLineId: null,
        quantityInitial: new Prisma.Decimal(qty),
        quantityRemaining: new Prisma.Decimal(qty),
        unitCode: "g",
        locationCode: ["FRIDGE", "FREEZER", "PANTRY"][Math.floor(rand() * 3)],
        purchasedAt,
        expiresAt,
        currency: "USD",
        costTotal: new Prisma.Decimal(cost),
      });
    }
  }

  console.log(`[seed] lotsToCreate=${lotData.length}`);

  for (const part of chunk(lotData, 500)) {
    await prisma.inventoryLot.createMany({ data: part });
  }

  // 3) Create consumption events (tenant-scoped) to exercise forecast math
  // InventoryEvent unique key: (householdId, requestId)
  // We'll set requestId with prefix to allow safe cleanup.
  const eventData: Prisma.InventoryEventCreateManyInput[] = [];
  let eventCounter = 0;

  for (const c of canonicals) {
    for (let k = 0; k < eventsPerItem; k++) {
      const daysAgo = Math.floor(rand() * days);
      const createdAt = new Date(Date.now() - daysAgo * msDay);

      const grams = Math.floor(10 + rand() * 250); // 10g..260g per event

      eventData.push({
        householdId,
        type: "LOT_CONSUMED",
        actorUserId: actorUserId ?? null,
        entityType: "LOT",
        entityId: null,
        requestId: `${prefix}_EV_${String(eventCounter++).padStart(7, "0")}`,
        payload: {
          canonicalItemId: c.id,
          unitCode: "g",
          quantity: grams,
          notes: "seed consumption event",
        } as any,
        createdAt,
      });
    }
  }

  console.log(`[seed] eventsToCreate=${eventData.length}`);

  for (const part of chunk(eventData, 500)) {
    await prisma.inventoryEvent.createMany({ data: part });
  }

  console.log(`[done] ✅ Seeded:
  canonicalItems=${canonicals.length}
  lots=${lotData.length}
  events=${eventData.length}
  prefix=${prefix}
  `);

  console.log(`[next] Run:
  curl -s "$CHAIF/v1/assistant/actions?householdId=${householdId}" -H "Authorization: Bearer $TOKEN" | jq
  curl -s "$CHAIF/v1/inventory/forecast?householdId=${householdId}&windowDays=14" -H "Authorization: Bearer $TOKEN" | jq
  `);
}

main()
  .catch((e) => {
    console.error("[seedScale] ❌", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });