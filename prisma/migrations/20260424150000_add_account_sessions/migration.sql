-- CreateTable
CREATE TABLE "AccountSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,

    CONSTRAINT "AccountSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountSession_accountId_startedAt_idx" ON "AccountSession"("accountId", "startedAt");

-- CreateIndex
CREATE INDEX "AccountSession_startedAt_idx" ON "AccountSession"("startedAt");

-- AddForeignKey
ALTER TABLE "AccountSession" ADD CONSTRAINT "AccountSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
