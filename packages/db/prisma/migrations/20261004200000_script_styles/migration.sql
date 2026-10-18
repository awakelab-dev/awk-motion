-- Estilos de guion (hito 6, ADR-072): cómo leer un PDF o Word de guion; cada proyecto recuerda el último.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "scriptStyleId" UUID;

-- CreateTable
CREATE TABLE "ScriptStyle" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "structure" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptStyle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScriptStyle_ownerId_name_key" ON "ScriptStyle"("ownerId", "name");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_scriptStyleId_fkey" FOREIGN KEY ("scriptStyleId") REFERENCES "ScriptStyle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptStyle" ADD CONSTRAINT "ScriptStyle_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
