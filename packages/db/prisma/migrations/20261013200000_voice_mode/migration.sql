-- Hito 10 (ADR-133): cómo se pidió la locución ("whole" = un solo pedido; nulo = por párrafo).
ALTER TABLE "Generation" ADD COLUMN "voiceMode" TEXT;
