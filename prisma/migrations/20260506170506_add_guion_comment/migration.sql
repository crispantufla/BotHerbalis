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

-- CreateIndex
CREATE INDEX "GuionComment_script_idx" ON "GuionComment"("script");

-- CreateIndex
CREATE INDEX "GuionComment_script_sectionPath_idx" ON "GuionComment"("script", "sectionPath");

-- CreateIndex
CREATE INDEX "GuionComment_resolved_idx" ON "GuionComment"("resolved");
