-- Sonido de los clips (hito 6, ADR-059): audio nativo de MiniMax, SFX sintetizados o sin sonido.

-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "soundGainDb" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "soundMode" TEXT;

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "soundLufs" DOUBLE PRECISION,
ADD COLUMN     "soundMode" TEXT;
