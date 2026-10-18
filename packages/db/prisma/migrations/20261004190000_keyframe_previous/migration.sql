-- Fotograma propuesto en un video terminado (hito 6, ADR-071): la versión vigente mientras no se aplica.
ALTER TABLE "Keyframe" ADD COLUMN "previous" JSONB;
