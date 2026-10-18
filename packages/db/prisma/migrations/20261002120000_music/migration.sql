-- Música de fondo por video (hito 5, ADR-044).

-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "musicTrack" TEXT;

-- CreateTable
CREATE TABLE "MusicTrack" (
    "name" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mtimeMs" DOUBLE PRECISION NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "lufs" DOUBLE PRECISION,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MusicTrack_pkey" PRIMARY KEY ("name")
);

-- Los videos anteriores se renderizaron con MUSIC_PATH (assets/music/Inspiring.mp3).
UPDATE "Generation" SET "musicTrack" = 'Inspiring.mp3';
