-- Entrega (hito 6, ADR-065): logo y ajustes del reproductor por proyecto, ajuste fino por video.

-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "delivery" JSONB;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "delivery" JSONB;
