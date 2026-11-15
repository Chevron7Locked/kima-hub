-- The page whose play button started the saved queue, so a restored queue keeps its page's play button.
ALTER TABLE "PlaybackState" ADD COLUMN "queueSource" TEXT;
