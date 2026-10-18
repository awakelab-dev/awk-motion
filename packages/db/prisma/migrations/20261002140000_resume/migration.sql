-- Retomar las generaciones tras un reinicio sin pagar dos veces (hito 5, ADR-046).

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "taskId" TEXT;

-- AlterTable
ALTER TABLE "Keyframe" ADD COLUMN     "pending" JSONB;
