-- Audiobook sections remediation (plan v0.3.0).
-- Replace live-raw-ABS-chapters path with cached, validated sections model.
-- sectionsJson stores [{index,title,start}] computed by buildSections at sync time.
-- numChapters was never surfaced to clients; dropped to remove the dead field.
ALTER TABLE "Audiobook" ADD COLUMN "sectionsJson" JSONB;
ALTER TABLE "Audiobook" DROP COLUMN "numChapters";
