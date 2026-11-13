-- Plays are no longer labelled by what the suggestion was: where the album is says that. Every version from 1.0.0 until
-- 2026-10-28 wrote DISCOVERY and DISCOVERY_KEPT, so existing servers hold them; they become plain library plays, and
-- both labels leave the type (Postgres cannot drop an enum value, so the type is replaced).
UPDATE "Play" SET "source" = 'LIBRARY' WHERE "source" IN ('DISCOVERY', 'DISCOVERY_KEPT');

CREATE TYPE "ListenSource_new" AS ENUM ('LIBRARY', 'SUBSONIC');

ALTER TABLE "Play" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "Play" ALTER COLUMN "source" TYPE "ListenSource_new" USING ("source"::text::"ListenSource_new");
ALTER TABLE "Play" ALTER COLUMN "source" SET DEFAULT 'LIBRARY';

DROP TYPE "ListenSource";
ALTER TYPE "ListenSource_new" RENAME TO "ListenSource";
