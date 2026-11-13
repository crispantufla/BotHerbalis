-- CreateTable
CREATE TABLE "AdLead" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT,
    "mediaType" INTEGER,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messages" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AdLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdLead_instanceId_phone_sourceId_key" ON "AdLead"("instanceId", "phone", "sourceId");

-- CreateIndex
CREATE INDEX "AdLead_instanceId_sourceId_firstAt_idx" ON "AdLead"("instanceId", "sourceId", "firstAt");
