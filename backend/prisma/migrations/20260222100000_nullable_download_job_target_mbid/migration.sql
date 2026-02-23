-- AlterTable: allow targetMbid to be null for direct search downloads
ALTER TABLE "DownloadJob" ALTER COLUMN "targetMbid" DROP NOT NULL;
