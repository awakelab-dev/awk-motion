-- Observaciones y aprobación del cliente en el link de revisión del storyboard (hito 8, A4, ADR-098).

-- CreateTable
CREATE TABLE "ReviewComment" (
    "id" UUID NOT NULL,
    "generationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'comment',
    "keyframeIndex" INTEGER,
    "keyframeVersion" INTEGER,
    "versions" JSONB,
    "author" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewComment_generationId_createdAt_idx" ON "ReviewComment"("generationId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewComment_createdAt_idx" ON "ReviewComment"("createdAt");

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
