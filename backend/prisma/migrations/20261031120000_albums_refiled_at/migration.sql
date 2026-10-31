-- When an admin last re-filed every album by its songs' tags (services/albumRefile.ts); null until it has run.
-- The 1.12 release window's re-file item stays open until then.
ALTER TABLE "SystemSettings" ADD COLUMN "albumsRefiledAt" TIMESTAMP(3);
