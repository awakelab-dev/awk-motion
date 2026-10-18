-- Cola global de trabajos por recurso (hito 5, ADR-045).

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('queued', 'running', 'done', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "QueueTask" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "generationId" TEXT,
    "themeId" TEXT,
    "resource" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "priority" TIMESTAMP(3) NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "QueueTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QueueTask_resource_status_priority_seq_idx" ON "QueueTask"("resource", "status", "priority", "seq");

-- CreateIndex
CREATE INDEX "QueueTask_generationId_status_idx" ON "QueueTask"("generationId", "status");

