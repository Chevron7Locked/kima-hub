-- The seven raw MusiCNN mood scores. Moods come from the learned mood heads scored on each song's sound vector (the
-- mood step); nothing read these, and the analyzer no longer computes them. Dropping a column drops its index.
ALTER TABLE "Track"
    DROP COLUMN "moodHappy",
    DROP COLUMN "moodSad",
    DROP COLUMN "moodRelaxed",
    DROP COLUMN "moodAggressive",
    DROP COLUMN "moodParty",
    DROP COLUMN "moodAcoustic",
    DROP COLUMN "moodElectronic";
