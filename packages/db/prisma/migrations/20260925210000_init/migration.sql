-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "ThemeStatus" AS ENUM ('draft', 'saved');

-- CreateEnum
CREATE TYPE "GenerationMode" AS ENUM ('mcp', 'api', 'mock');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('queued', 'voice', 'timings', 'storyboard', 'keyframes', 'awaiting_approval', 'clips', 'post', 'render', 'done', 'error');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('pending', 'generating', 'ready', 'error');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('tts', 'timing', 'llm', 'image', 'video', 'upload');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('info', 'warn', 'error');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Theme" (
    "id" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "status" "ThemeStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "brief" JSONB NOT NULL,
    "style" JSONB NOT NULL,
    "basedOn" TEXT,
    "thumbnailTest" INTEGER,
    "proposalNotes" TEXT,
    "dir" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThemeReference" (
    "id" UUID NOT NULL,
    "themeId" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "mediaId" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThemeReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThemeTest" (
    "id" UUID NOT NULL,
    "themeId" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "themeVersion" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "frames" JSONB NOT NULL,
    "withClip" BOOLEAN NOT NULL DEFAULT false,
    "clip" JSONB NOT NULL,
    "reviewSummary" TEXT,
    "suggestions" JSONB,
    "creditsEstimated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "ThemeTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Generation" (
    "id" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "mode" "GenerationMode" NOT NULL,
    "themeKey" TEXT NOT NULL,
    "themeId" TEXT,
    "themeName" TEXT,
    "themeCopy" JSONB NOT NULL,
    "voiceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "searchVector" tsvector,
    "status" "GenerationStatus" NOT NULL DEFAULT 'queued',
    "message" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "durationSec" DOUBLE PRECISION,
    "totalFrames" INTEGER,
    "voicePath" TEXT,
    "finalPath" TEXT,
    "finalFrames" INTEGER,
    "creditsEstimated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceBefore" DOUBLE PRECISION,
    "balanceAfter" DOUBLE PRECISION,
    "words" JSONB,
    "storyboard" JSONB,
    "plan" JSONB,
    "shots" JSONB,
    "dir" TEXT NOT NULL,

    CONSTRAINT "Generation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paragraph" (
    "id" UUID NOT NULL,
    "generationId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Paragraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyframe" (
    "id" UUID NOT NULL,
    "generationId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "texts" TEXT[],
    "prompt" TEXT NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "review" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Keyframe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyframeVersion" (
    "id" UUID NOT NULL,
    "keyframeId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "path" TEXT,
    "prompt" TEXT NOT NULL,
    "remoteRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeyframeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clip" (
    "id" UUID NOT NULL,
    "generationId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "startFrame" INTEGER NOT NULL,
    "slotEndFrame" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deliveredFrames" INTEGER,
    "ssimStart" DOUBLE PRECISION,
    "ssimEnd" DOUBLE PRECISION,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipVersion" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "path" TEXT,
    "prompt" TEXT NOT NULL,
    "remoteRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prompt" (
    "id" UUID NOT NULL,
    "generationId" TEXT,
    "themeTestId" UUID,
    "themeId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "generationId" TEXT,
    "themeTestId" UUID,
    "themeId" TEXT,
    "kind" "JobKind" NOT NULL,
    "target" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "externalId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'running',
    "credits" DOUBLE PRECISION,
    "costUsd" DECIMAL(12,6),
    "usage" JSONB,
    "url" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogEntry" (
    "id" BIGSERIAL NOT NULL,
    "generationId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,

    CONSTRAINT "LogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Theme_ownerId_status_idx" ON "Theme"("ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ThemeReference_themeId_file_key" ON "ThemeReference"("themeId", "file");

-- CreateIndex
CREATE UNIQUE INDEX "ThemeTest_themeId_n_key" ON "ThemeTest"("themeId", "n");

-- CreateIndex
CREATE INDEX "Generation_ownerId_createdAt_idx" ON "Generation"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Generation_ownerId_status_idx" ON "Generation"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Generation_ownerId_themeKey_idx" ON "Generation"("ownerId", "themeKey");

-- CreateIndex
CREATE INDEX "Generation_searchVector_idx" ON "Generation" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "Paragraph_generationId_index_key" ON "Paragraph"("generationId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Keyframe_generationId_index_key" ON "Keyframe"("generationId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "KeyframeVersion_keyframeId_version_key" ON "KeyframeVersion"("keyframeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Clip_generationId_index_key" ON "Clip"("generationId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "ClipVersion_clipId_version_key" ON "ClipVersion"("clipId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Prompt_generationId_name_key" ON "Prompt"("generationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Prompt_themeTestId_name_key" ON "Prompt"("themeTestId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Prompt_themeId_name_key" ON "Prompt"("themeId", "name");

-- CreateIndex
CREATE INDEX "GenerationJob_ownerId_startedAt_idx" ON "GenerationJob"("ownerId", "startedAt");

-- CreateIndex
CREATE INDEX "GenerationJob_generationId_idx" ON "GenerationJob"("generationId");

-- CreateIndex
CREATE INDEX "GenerationJob_themeId_idx" ON "GenerationJob"("themeId");

-- CreateIndex
CREATE INDEX "LogEntry_generationId_id_idx" ON "LogEntry"("generationId", "id");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Theme" ADD CONSTRAINT "Theme_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThemeReference" ADD CONSTRAINT "ThemeReference_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThemeTest" ADD CONSTRAINT "ThemeTest_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paragraph" ADD CONSTRAINT "Paragraph_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyframe" ADD CONSTRAINT "Keyframe_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyframeVersion" ADD CONSTRAINT "KeyframeVersion_keyframeId_fkey" FOREIGN KEY ("keyframeId") REFERENCES "Keyframe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipVersion" ADD CONSTRAINT "ClipVersion_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prompt" ADD CONSTRAINT "Prompt_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prompt" ADD CONSTRAINT "Prompt_themeTestId_fkey" FOREIGN KEY ("themeTestId") REFERENCES "ThemeTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prompt" ADD CONSTRAINT "Prompt_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_themeTestId_fkey" FOREIGN KEY ("themeTestId") REFERENCES "ThemeTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LogEntry" ADD CONSTRAINT "LogEntry_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
