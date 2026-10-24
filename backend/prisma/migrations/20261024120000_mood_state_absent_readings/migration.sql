-- A reading no eligible track has is stored as absent (NULL) instead of refusing every mood's statistics; a recipe
-- that blends the absent reading refuses on its own.
ALTER TABLE "mood_state"
    ALTER COLUMN "arousal_mean" DROP NOT NULL,
    ALTER COLUMN "arousal_sd" DROP NOT NULL,
    ALTER COLUMN "instrumental_logit_mean" DROP NOT NULL,
    ALTER COLUMN "instrumental_logit_sd" DROP NOT NULL,
    ALTER COLUMN "acoustic_logit_mean" DROP NOT NULL,
    ALTER COLUMN "acoustic_logit_sd" DROP NOT NULL;
