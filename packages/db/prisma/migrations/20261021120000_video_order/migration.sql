-- Hito 12 (ADR-162): orden manual de los videos dentro de un proyecto.
-- Nace con la hora de creación (segundos desde 1970); los videos de hoy quedan en el orden de siempre (el más antiguo primero).
ALTER TABLE "Generation" ADD COLUMN "sortKey" DOUBLE PRECISION NOT NULL DEFAULT date_part('epoch'::text, now());
UPDATE "Generation" SET "sortKey" = date_part('epoch'::text, "createdAt");
CREATE INDEX "Generation_projectId_sortKey_idx" ON "Generation"("projectId", "sortKey");
