-- CreateTable
CREATE TABLE "FunnelEvent" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "stepFrom" TEXT,
    "stepTo" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "exitType" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "aiCallCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FunnelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FunnelEvent_sellerId_enteredAt_idx" ON "FunnelEvent"("sellerId", "enteredAt");

-- CreateIndex
CREATE INDEX "FunnelEvent_sellerId_stepTo_idx" ON "FunnelEvent"("sellerId", "stepTo");

-- CreateIndex
CREATE INDEX "FunnelEvent_phone_sellerId_idx" ON "FunnelEvent"("phone", "sellerId");

-- CreateIndex
CREATE INDEX "FunnelEvent_sellerId_exitedAt_idx" ON "FunnelEvent"("sellerId", "exitedAt");
