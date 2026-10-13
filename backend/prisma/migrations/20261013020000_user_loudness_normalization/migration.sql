-- Per-user loudness normalization toggle for the web player.
ALTER TABLE "UserSettings" ADD COLUMN "loudnessNormalization" BOOLEAN NOT NULL DEFAULT false;
