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
CREATE INDEX "AiSemanticCache_step_idx" ON "AiSemanticCache"("step");

-- CreateIndex
CREATE INDEX "AiSemanticCache_lastHit_idx" ON "AiSemanticCache"("lastHit");
