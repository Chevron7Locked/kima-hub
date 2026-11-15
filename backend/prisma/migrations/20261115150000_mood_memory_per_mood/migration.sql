-- What a listener was served is remembered per mood, so saving a mix for another mood no longer forgets it. It was one
-- list on the saved mix, which a save for a different mood started over.
CREATE TABLE "UserMoodMemory" (
    "userId" TEXT NOT NULL,
    "mood" TEXT NOT NULL,
    "servedTrackIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMoodMemory_pkey" PRIMARY KEY ("userId","mood")
);

ALTER TABLE "UserMoodMemory" ADD CONSTRAINT "UserMoodMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each listener's one remembered list belongs to the mood of their saved mix.
INSERT INTO "UserMoodMemory" ("userId", "mood", "servedTrackIds", "updatedAt")
SELECT "userId", "mood", "servedTrackIds", "updatedAt" FROM "UserMoodMix" WHERE cardinality("servedTrackIds") > 0;

ALTER TABLE "UserMoodMix" DROP COLUMN "servedTrackIds";
