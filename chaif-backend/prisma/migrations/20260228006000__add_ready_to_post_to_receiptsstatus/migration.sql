-- Add READY_TO_POST to the Postgres enum type used by ReceiptRaw.status
-- Enum type name confirmed: ReceiptsStatus

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'ReceiptsStatus'
      AND e.enumlabel = 'READY_TO_POST'
  ) THEN
    ALTER TYPE "ReceiptsStatus" ADD VALUE 'READY_TO_POST';
  END IF;
END $$;