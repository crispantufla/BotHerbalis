-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "aiCalled" BOOLEAN NOT NULL DEFAULT false,
    "priceObjection" BOOLEAN NOT NULL DEFAULT false,
    "retryIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageEvent_sellerId_at_idx" ON "MessageEvent"("sellerId", "at");

-- CreateIndex
CREATE INDEX "MessageEvent_sellerId_step_at_idx" ON "MessageEvent"("sellerId", "step", "at");
