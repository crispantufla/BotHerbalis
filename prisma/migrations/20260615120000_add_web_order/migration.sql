-- CreateTable
CREATE TABLE "WebOrder" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "externalRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "items" JSONB NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "shipping" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "nombre" TEXT,
    "apellido" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "provincia" TEXT,
    "ciudad" TEXT,
    "calle" TEXT,
    "piso" TEXT,
    "cp" TEXT,
    "notas" TEXT,
    "mpPaymentId" TEXT,
    "mpStatus" TEXT,
    "mpStatusDetail" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebOrder_externalRef_key" ON "WebOrder"("externalRef");

-- CreateIndex
CREATE INDEX "WebOrder_status_idx" ON "WebOrder"("status");

-- CreateIndex
CREATE INDEX "WebOrder_createdAt_idx" ON "WebOrder"("createdAt");

-- CreateIndex
CREATE INDEX "WebOrder_instanceId_idx" ON "WebOrder"("instanceId");
