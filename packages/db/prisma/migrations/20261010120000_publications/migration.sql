-- Publicaciones de videos en el prefijo público del almacenamiento (hito 9, T1, ADR-101).

-- CreateTable
CREATE TABLE "Publication" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "generationId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "quality" JSONB NOT NULL,
    "logo" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "source" JSONB,
    "files" JSONB,
    "bytes" BIGINT,
    "uses" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Publication_token_key" ON "Publication"("token");

-- CreateIndex
CREATE INDEX "Publication_ownerId_createdAt_idx" ON "Publication"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Publication_generationId_variant_key" ON "Publication"("generationId", "variant");

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
