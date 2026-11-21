-- Hito 13a (ADR-177): voz del proyecto (versión, semilla y velocidad) y de cada video.
-- Las columnas se agregan sin valor por defecto (los proyectos y videos existentes quedan en v3 y a velocidad 1) y
-- después se fija el valor por defecto de los proyectos nuevos (v4 a 0,85).
ALTER TABLE "Project" ADD COLUMN "voiceModel" TEXT,
ADD COLUMN "voiceSeed" INTEGER,
ADD COLUMN "voiceSpeed" DOUBLE PRECISION;

ALTER TABLE "Project" ALTER COLUMN "voiceModel" SET DEFAULT 'v4',
ALTER COLUMN "voiceSpeed" SET DEFAULT 0.85;

ALTER TABLE "Generation" ADD COLUMN "voiceModel" TEXT,
ADD COLUMN "voiceSeed" INTEGER,
ADD COLUMN "voiceSpeed" DOUBLE PRECISION,
ADD COLUMN "syncRule" TEXT;
