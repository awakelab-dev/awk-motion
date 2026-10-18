-- Papelera de videos y proyectos (hito 9, T3d, ADR-106).

-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "trashedAt" TIMESTAMP(3),
ADD COLUMN     "trashedWithProject" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "trashedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Generation_ownerId_trashedAt_idx" ON "Generation"("ownerId", "trashedAt");
