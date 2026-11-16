-- The marker column holds UTC (Prisma writes it so), but its default was CURRENT_TIMESTAMP, which a column without a time
-- zone stores in the database session's zone. On a server not set to UTC, a row created with the default started hours
-- off, and the marker, which never goes backwards, stayed there. The default is now the UTC time.
ALTER TABLE "SystemSettings" ALTER COLUMN "libraryChangedAt" SET DEFAULT (timezone('utc'::text, now()));
-- A marker already ahead of the present is one the old default skewed (it never goes forward of a real change), so it comes back to now.
UPDATE "SystemSettings" SET "libraryChangedAt" = timezone('utc'::text, now()) WHERE "libraryChangedAt" > timezone('utc'::text, now());
