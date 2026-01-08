-- AlterTable
ALTER TABLE "Album" ADD COLUMN     "displayTitle" TEXT,
ADD COLUMN     "displayYear" INTEGER,
ADD COLUMN     "hasUserOverrides" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userCoverUrl" TEXT,
ADD COLUMN     "userGenres" JSONB;

-- AlterTable
ALTER TABLE "Artist" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "hasUserOverrides" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userGenres" JSONB,
ADD COLUMN     "userHeroUrl" TEXT,
ADD COLUMN     "userSummary" TEXT;

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "displayTitle" TEXT,
ADD COLUMN     "displayTrackNo" INTEGER,
ADD COLUMN     "hasUserOverrides" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Album_hasUserOverrides_idx" ON "Album"("hasUserOverrides");

-- CreateIndex
CREATE INDEX "Artist_hasUserOverrides_idx" ON "Artist"("hasUserOverrides");

-- CreateIndex
CREATE INDEX "Track_hasUserOverrides_idx" ON "Track"("hasUserOverrides");
