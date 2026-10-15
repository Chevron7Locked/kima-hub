-- AlterTable
ALTER TABLE "Podcast" ADD COLUMN     "categoryIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN     "podcastChartCountry" TEXT NOT NULL DEFAULT 'us';

