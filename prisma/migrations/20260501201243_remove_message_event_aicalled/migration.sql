-- Drop deprecated MessageEvent.aiCalled column.
-- The flag was always false by design (logMessage never set it). Real AI usage
-- lives in FunnelEvent.aiCallCount, incremented directly from ai.ts.
ALTER TABLE "MessageEvent" DROP COLUMN "aiCalled";
