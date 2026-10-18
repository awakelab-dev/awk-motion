-- Lotes de descarga (hito 7, ADR-087).

-- CreateEnum
CREATE TYPE "DownloadBatchStatus" AS ENUM ('queued', 'preparing', 'packing', 'ready', 'error');

-- CreateTable
CREATE TABLE "DownloadBatch" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectName" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "videoIds" JSONB NOT NULL,
    "status" "DownloadBatchStatus" NOT NULL DEFAULT 'queued',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "skipped" JSONB,
    "fileName" TEXT NOT NULL,
    "bytes" BIGINT,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "DownloadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DownloadBatch_status_createdAt_idx" ON "DownloadBatch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DownloadBatch_ownerId_createdAt_idx" ON "DownloadBatch"("ownerId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "DownloadBatch" ADD CONSTRAINT "DownloadBatch_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
