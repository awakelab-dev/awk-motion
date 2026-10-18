-- Almacenamiento de medios en S3 con caché local (hito 8, ADR-093).

-- CreateTable
CREATE TABLE "StoredObject" (
    "key" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mtimeMs" DOUBLE PRECISION NOT NULL,
    "etag" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "MediaDir" (
    "dir" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evictedAt" TIMESTAMP(3),

    CONSTRAINT "MediaDir_pkey" PRIMARY KEY ("dir")
);
