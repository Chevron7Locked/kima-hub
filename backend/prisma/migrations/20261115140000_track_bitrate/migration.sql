-- The file's own bitrate in kbps, read from its headers by the scan; null until the file is next read, or when it reports none.
ALTER TABLE "Track" ADD COLUMN "bitrate" INTEGER;
