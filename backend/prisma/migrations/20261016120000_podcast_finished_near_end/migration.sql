-- Positions saved past an episode's listed end, from before the progress route counted the last 5% as finished
-- (the browser's pause at the end of a file could overwrite the finished save). Past the end is finished; anything
-- short of it is left alone, since a listed length can be minutes short of the audio and no measured one is stored.
UPDATE "PodcastProgress"
   SET "isFinished" = true
 WHERE "isFinished" = false
   AND duration > 0
   AND "currentTime" >= duration;
