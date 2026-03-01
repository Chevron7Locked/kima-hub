-- CreateTable
CREATE TABLE "track_lyrics" (
    "track_id" TEXT NOT NULL,
    "plain_lyrics" TEXT,
    "synced_lyrics" TEXT,
    "source" VARCHAR(20) NOT NULL,
    "lrclib_id" INTEGER,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "track_lyrics_pkey" PRIMARY KEY ("track_id")
);

-- AddForeignKey
ALTER TABLE "track_lyrics" ADD CONSTRAINT "track_lyrics_track_id_fkey"
    FOREIGN KEY ("track_id") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;
