-- Essentia writes C# (not Db), and the Camelot table spelled only Db, so every C# track fell to the unknown-key
-- default (8B, C major) in the features-only similarity fallback: 456 of 8,971 tracks on the measured library
-- (kima-labs research/engine-audit-2026-10-18/AUDIT.md). The same table with each sharp spelling at its flat's place.
CREATE OR REPLACE FUNCTION key_similarity(key1 TEXT, scale1 TEXT, key2 TEXT, scale2 TEXT)
RETURNS FLOAT AS $$
DECLARE
    camelot JSONB := '{
        "Ab_minor": [1, "A"], "Eb_minor": [2, "A"], "Bb_minor": [3, "A"],
        "F_minor": [4, "A"], "C_minor": [5, "A"], "G_minor": [6, "A"],
        "D_minor": [7, "A"], "A_minor": [8, "A"], "E_minor": [9, "A"],
        "B_minor": [10, "A"], "F#_minor": [11, "A"], "Db_minor": [12, "A"],
        "B_major": [1, "B"], "F#_major": [2, "B"], "Db_major": [3, "B"],
        "Ab_major": [4, "B"], "Eb_major": [5, "B"], "Bb_major": [6, "B"],
        "F_major": [7, "B"], "C_major": [8, "B"], "G_major": [9, "B"],
        "D_major": [10, "B"], "A_major": [11, "B"], "E_major": [12, "B"],
        "C#_minor": [12, "A"], "G#_minor": [1, "A"], "D#_minor": [2, "A"], "A#_minor": [3, "A"],
        "C#_major": [3, "B"], "Gb_major": [2, "B"], "G#_major": [4, "B"], "D#_major": [5, "B"],
        "A#_major": [6, "B"], "Gb_minor": [11, "A"]
    }'::JSONB;
    k1 TEXT;
    k2 TEXT;
    pos1 INT;
    pos2 INT;
    mode1 TEXT;
    mode2 TEXT;
    circle_dist INT;
BEGIN
    IF key1 IS NULL OR key2 IS NULL THEN
        RETURN 0.5;
    END IF;

    k1 := key1 || '_' || COALESCE(scale1, 'major');
    k2 := key2 || '_' || COALESCE(scale2, 'major');

    pos1 := COALESCE((camelot->k1->>0)::INT, 8);
    mode1 := COALESCE(camelot->k1->>1, 'B');
    pos2 := COALESCE((camelot->k2->>0)::INT, 8);
    mode2 := COALESCE(camelot->k2->>1, 'B');

    circle_dist := LEAST(ABS(pos1 - pos2), 12 - ABS(pos1 - pos2));

    IF pos1 = pos2 AND mode1 = mode2 THEN
        RETURN 1.0;
    END IF;

    IF pos1 = pos2 AND mode1 != mode2 THEN
        RETURN 0.92;
    END IF;

    IF circle_dist = 1 THEN
        RETURN CASE WHEN mode1 = mode2 THEN 0.85 ELSE 0.75 END;
    END IF;

    RETURN GREATEST(0.0, 1.0 - (circle_dist * 0.15) - (CASE WHEN mode1 != mode2 THEN 0.1 ELSE 0 END));
END;
$$ LANGUAGE plpgsql IMMUTABLE;
