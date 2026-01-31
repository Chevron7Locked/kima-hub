-- BPM similarity function with octave folding
CREATE OR REPLACE FUNCTION bpm_similarity(bpm1 FLOAT, bpm2 FLOAT)
RETURNS FLOAT AS $$
DECLARE
    norm1 FLOAT;
    norm2 FLOAT;
    direct_diff FLOAT;
    half_diff FLOAT;
    tolerance FLOAT := 20;
    harmonic_tolerance FLOAT := 10;
BEGIN
    IF bpm1 IS NULL OR bpm2 IS NULL THEN
        RETURN 0.5;
    END IF;

    norm1 := bpm1;
    WHILE norm1 < 70 LOOP norm1 := norm1 * 2; END LOOP;
    WHILE norm1 > 140 LOOP norm1 := norm1 / 2; END LOOP;

    norm2 := bpm2;
    WHILE norm2 < 70 LOOP norm2 := norm2 * 2; END LOOP;
    WHILE norm2 > 140 LOOP norm2 := norm2 / 2; END LOOP;

    direct_diff := ABS(norm1 - norm2);

    IF direct_diff <= tolerance THEN
        RETURN 1.0 - (direct_diff / tolerance) * 0.3;
    END IF;

    half_diff := LEAST(ABS(bpm1 - bpm2 * 2), ABS(bpm1 * 2 - bpm2));
    IF half_diff <= harmonic_tolerance THEN
        RETURN 0.75 - (half_diff / harmonic_tolerance) * 0.15;
    END IF;

    RETURN GREATEST(0.0, 0.6 - (direct_diff - tolerance) / 60);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Key similarity using Camelot wheel
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
        "D_major": [10, "B"], "A_major": [11, "B"], "E_major": [12, "B"]
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
