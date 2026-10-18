-- Rehacer audio y reglas de pronunciación (hito 5, ADR-048).

-- AlterTable
ALTER TABLE "Paragraph" ADD COLUMN     "spokenText" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "PronunciationRule" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "match" TEXT NOT NULL,
    "say" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PronunciationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PronunciationRule_ownerId_match_key" ON "PronunciationRule"("ownerId", "match");

-- AddForeignKey
ALTER TABLE "PronunciationRule" ADD CONSTRAINT "PronunciationRule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
