-- CreateTable
CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "preferenceId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "link" TEXT NOT NULL,
    "userPhone" TEXT,
    "sellerPhone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'dashboard',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_preferenceId_key" ON "PaymentLink"("preferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_externalRef_key" ON "PaymentLink"("externalRef");

-- CreateIndex
CREATE INDEX "PaymentLink_status_idx" ON "PaymentLink"("status");

-- CreateIndex
CREATE INDEX "PaymentLink_createdAt_idx" ON "PaymentLink"("createdAt");

-- CreateIndex
CREATE INDEX "PaymentLink_instanceId_idx" ON "PaymentLink"("instanceId");
