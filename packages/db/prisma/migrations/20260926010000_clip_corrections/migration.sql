-- Corrección de videos terminados (hito 3, ADR-033).

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "endKeyVersion" INTEGER,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "startKeyVersion" INTEGER;
