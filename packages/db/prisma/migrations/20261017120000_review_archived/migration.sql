-- «Archivada» en las observaciones del cliente (hito 10, ADR-140).
ALTER TABLE "ReviewComment" ADD COLUMN "archivedAt" TIMESTAMP(3);
