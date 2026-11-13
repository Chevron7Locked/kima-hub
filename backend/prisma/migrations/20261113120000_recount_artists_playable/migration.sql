-- Artist counts now count only albums and songs that play (services/artistCountsService.ts). Marking every artist
-- uncounted makes the next startup recount them all, so an upgraded install does not keep the old counts until a scan.
UPDATE "Artist" SET "countsLastUpdated" = NULL;
