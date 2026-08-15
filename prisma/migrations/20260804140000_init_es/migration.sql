-- Baseline del fork España: el schema completo en una sola migración.
--
-- POR QUÉ SE APLASTÓ EL HISTORIAL:
-- El historial heredado del bot argentino NO puede reconstruir una base desde
-- cero. Buena parte del schema (las 5 tablas AiErrorReport, DailyStats,
-- Account, WhatsAppSession y QuickReply, y las columnas `instanceId` del
-- particionado multi-tenant) se creó en su día con `prisma db push`, sin dejar
-- migración. En Argentina no se nota porque su base ya las tiene; sobre una
-- base vacía, `migrate deploy` moría a mitad de camino (P3009 / 42703).
--
-- Este archivo lo generó Prisma a partir de schema.prisma
-- (`prisma migrate diff --from-empty --to-schema`), así que refleja el schema
-- REAL, no lo que las migraciones sueltas creían.
--
-- CONSECUENCIA A TENER EN CUENTA: los dos repos ya no comparten historial de
-- migraciones. Traer una migración del bot argentino con un cherry-pick ya no
-- basta: hay que mirar si el cambio aplica y escribirla aquí. El historial
-- viejo sigue en el git de este repo, en los commits anteriores al fork.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "phone" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profileData" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pauseReason" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("phone","instanceId")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "userPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pendiente',
    "products" TEXT NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "tracking" TEXT,
    "postdated" TEXT,
    "seller" TEXT,
    "paymentMethod" TEXT,
    "senaAmount" INTEGER,
    "senaPaid" BOOLEAN NOT NULL DEFAULT false,
    "cashRemainder" INTEGER,
    "paymentVerifiedAt" TIMESTAMP(3),
    "nombre" TEXT,
    "email" TEXT,
    "calle" TEXT,
    "calleOriginal" TEXT,
    "ciudad" TEXT,
    "provincia" TEXT,
    "cp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatLog" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "userPhone" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotConfig" (
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "BotConfig_pkey" PRIMARY KEY ("instanceId","key")
);

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

-- CreateTable
CREATE TABLE "AiErrorReport" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "userPhone" TEXT NOT NULL,
    "reportedMessage" TEXT NOT NULL,
    "conversation" TEXT NOT NULL,
    "correction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiErrorReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyStats" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "date" TIMESTAMP(3) NOT NULL,
    "totalChats" INTEGER NOT NULL,
    "completedOrders" INTEGER NOT NULL,
    "totalRevenue" DOUBLE PRECISION NOT NULL,
    "stepCounts" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'seller',
    "sellerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totalOnlineSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,

    CONSTRAINT "AccountSession_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "priceObjection" BOOLEAN NOT NULL DEFAULT false,
    "retryIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppSession" (
    "sellerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "phoneNumber" TEXT,
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppSession_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "QuickReply" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'default',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuionComment" (
    "id" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "sectionPath" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'note',
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "suggestedText" TEXT,
    "reactions" TEXT NOT NULL DEFAULT '[]',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuionComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

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
    "currency" TEXT NOT NULL DEFAULT 'EUR',
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
    "shipped" BOOLEAN NOT NULL DEFAULT false,
    "tracking" TEXT,
    "shippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSemanticCache" (
    "id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "userText" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHit" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSemanticCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_instanceId_createdAt_idx" ON "User"("instanceId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_userPhone_instanceId_idx" ON "Order"("userPhone", "instanceId");

-- CreateIndex
CREATE INDEX "Order_instanceId_idx" ON "Order"("instanceId");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "ChatLog_userPhone_instanceId_idx" ON "ChatLog"("userPhone", "instanceId");

-- CreateIndex
CREATE INDEX "ChatLog_userPhone_instanceId_timestamp_idx" ON "ChatLog"("userPhone", "instanceId", "timestamp");

-- CreateIndex
CREATE INDEX "ChatLog_timestamp_idx" ON "ChatLog"("timestamp");

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

-- CreateIndex
CREATE INDEX "AiErrorReport_instanceId_idx" ON "AiErrorReport"("instanceId");

-- CreateIndex
CREATE INDEX "AiErrorReport_createdAt_idx" ON "AiErrorReport"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStats_instanceId_date_key" ON "DailyStats"("instanceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Account_name_key" ON "Account"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Account_sellerId_key" ON "Account"("sellerId");

-- CreateIndex
CREATE INDEX "Account_role_idx" ON "Account"("role");

-- CreateIndex
CREATE INDEX "AccountSession_accountId_startedAt_idx" ON "AccountSession"("accountId", "startedAt");

-- CreateIndex
CREATE INDEX "AccountSession_startedAt_idx" ON "AccountSession"("startedAt");

-- CreateIndex
CREATE INDEX "FunnelEvent_sellerId_enteredAt_idx" ON "FunnelEvent"("sellerId", "enteredAt");

-- CreateIndex
CREATE INDEX "FunnelEvent_sellerId_stepTo_idx" ON "FunnelEvent"("sellerId", "stepTo");

-- CreateIndex
CREATE INDEX "FunnelEvent_phone_sellerId_idx" ON "FunnelEvent"("phone", "sellerId");

-- CreateIndex
CREATE INDEX "FunnelEvent_sellerId_exitedAt_idx" ON "FunnelEvent"("sellerId", "exitedAt");

-- CreateIndex
CREATE INDEX "MessageEvent_sellerId_at_idx" ON "MessageEvent"("sellerId", "at");

-- CreateIndex
CREATE INDEX "MessageEvent_sellerId_step_at_idx" ON "MessageEvent"("sellerId", "step", "at");

-- CreateIndex
CREATE INDEX "QuickReply_instanceId_idx" ON "QuickReply"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickReply_instanceId_title_key" ON "QuickReply"("instanceId", "title");

-- CreateIndex
CREATE INDEX "GuionComment_script_idx" ON "GuionComment"("script");

-- CreateIndex
CREATE INDEX "GuionComment_script_sectionPath_idx" ON "GuionComment"("script", "sectionPath");

-- CreateIndex
CREATE INDEX "GuionComment_resolved_idx" ON "GuionComment"("resolved");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_revokedAt_idx" ON "ApiToken"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebOrder_externalRef_key" ON "WebOrder"("externalRef");

-- CreateIndex
CREATE INDEX "WebOrder_status_idx" ON "WebOrder"("status");

-- CreateIndex
CREATE INDEX "WebOrder_createdAt_idx" ON "WebOrder"("createdAt");

-- CreateIndex
CREATE INDEX "WebOrder_instanceId_idx" ON "WebOrder"("instanceId");

-- CreateIndex
CREATE INDEX "AiSemanticCache_step_idx" ON "AiSemanticCache"("step");

-- CreateIndex
CREATE INDEX "AiSemanticCache_lastHit_idx" ON "AiSemanticCache"("lastHit");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userPhone_instanceId_fkey" FOREIGN KEY ("userPhone", "instanceId") REFERENCES "User"("phone", "instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatLog" ADD CONSTRAINT "ChatLog_userPhone_instanceId_fkey" FOREIGN KEY ("userPhone", "instanceId") REFERENCES "User"("phone", "instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSession" ADD CONSTRAINT "AccountSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

