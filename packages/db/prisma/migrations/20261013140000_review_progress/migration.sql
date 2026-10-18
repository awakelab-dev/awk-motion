-- T8 (ADR-119): estado «En curso» de las observaciones del cliente.
ALTER TABLE "ReviewComment" ADD COLUMN "inProgressAt" TIMESTAMP(3);
