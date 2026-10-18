-- Links de descarga para el cliente (hito 9, T5, ADR-111).

-- AlterTable
ALTER TABLE "DownloadBatch" ADD COLUMN "snapshot" JSONB;

-- CreateTable
CREATE TABLE "DownloadLink" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadAt" TIMESTAMP(3),

    CONSTRAINT "DownloadLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DownloadLink_token_key" ON "DownloadLink"("token");

-- CreateIndex
CREATE INDEX "DownloadLink_batchId_idx" ON "DownloadLink"("batchId");

-- AddForeignKey
ALTER TABLE "DownloadLink" ADD CONSTRAINT "DownloadLink_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DownloadBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
