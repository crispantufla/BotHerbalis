-- Campañas promo: reactivación de leads que hablaron y no compraron, un mensaje
-- por persona, espaciado como lo haría una persona. Ver src/services/promo/.
CREATE TABLE "PromoCampaign" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "config" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextSendAt" TIMESTAMP(3),
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentTodayDate" TEXT,
    "totalSent" INTEGER NOT NULL DEFAULT 0,
    "failStreak" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PromoCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PromoRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageText" TEXT,
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "skipReason" TEXT,

    CONSTRAINT "PromoRecipient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PromoCampaign_instanceId_status_idx" ON "PromoCampaign"("instanceId", "status");
CREATE UNIQUE INDEX "PromoRecipient_campaignId_phone_key" ON "PromoRecipient"("campaignId", "phone");
CREATE INDEX "PromoRecipient_instanceId_phone_idx" ON "PromoRecipient"("instanceId", "phone");
CREATE INDEX "PromoRecipient_campaignId_status_position_idx" ON "PromoRecipient"("campaignId", "status", "position");

ALTER TABLE "PromoRecipient" ADD CONSTRAINT "PromoRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "PromoCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
