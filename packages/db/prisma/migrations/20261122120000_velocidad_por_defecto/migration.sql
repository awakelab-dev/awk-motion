-- Hito 13a (ADR-180): los proyectos nuevos nacen a velocidad 1 (nulo), no a 0,85. Los que ya tienen una velocidad la conservan.
ALTER TABLE "Project" ALTER COLUMN "voiceSpeed" DROP DEFAULT;
