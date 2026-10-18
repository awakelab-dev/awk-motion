-- "Sin clasificar" (hito 4, ADR-035): todo video vive en un proyecto.
-- 1) Proyecto del sistema por usuario, 2) los videos sin proyecto pasan a él, 3) projectId obligatorio.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "system" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Project_ownerId_system_key" ON "Project"("ownerId", "system");

-- Datos: un "Sin clasificar" por cada usuario que aún no lo tenga.
INSERT INTO "Project" ("id", "ownerId", "name", "description", "system", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u."id", 'Sin clasificar', 'Videos que aún no están en ningún proyecto.', 'unclassified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User" u
WHERE NOT EXISTS (SELECT 1 FROM "Project" p WHERE p."ownerId" = u."id" AND p."system" = 'unclassified');

-- Datos: los videos sin proyecto (incluidos los importados) pasan a "Sin clasificar". Los archivos no se tocan.
UPDATE "Generation" g
SET "projectId" = p."id"
FROM "Project" p
WHERE g."projectId" IS NULL AND p."ownerId" = g."ownerId" AND p."system" = 'unclassified';

-- DropForeignKey
ALTER TABLE "Generation" DROP CONSTRAINT "Generation_projectId_fkey";

-- AlterTable
ALTER TABLE "Generation" ALTER COLUMN "projectId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
