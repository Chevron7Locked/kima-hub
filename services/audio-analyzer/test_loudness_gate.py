"""The loudness gate: an implausible measurement is stored as no measurement.
Found in the wild on real files: +2868.2 LUFS and a 47.06 LU range from corrupt
decodes. The gate lets every real reading through — including genuinely quiet
audio — and nulls only what the meter or a decode got wrong; a warning names the
file either way."""
import math

import analyzer
from analyzer import AudioAnalyzer


def gate(integrated, loudness_range):
    return AudioAnalyzer._plausible_loudness(integrated, loudness_range, "/music/test.flac")


def test_real_readings_pass():
    assert gate(-9.0, 11.2) == (-9.0, 11.2)
    assert gate(-23.0, 20.0) == (-23.0, 20.0)
    # the bounds themselves: a master pushed to the ceiling, a floor of near-silence
    assert gate(0.5, 0.0) == (0.5, 0.0)
    assert gate(-70.0, 5.0) == (-70.0, 5.0)


def test_the_garbage_found_stored_is_nulled():
    # the prod rows the audit named
    assert gate(2868.2, 47.06) == (None, None)
    assert gate(232.2, 43.64) == (None, None)
    assert gate(15.6, 38.6) == (None, None)
    # a meter that failed outright never becomes a stored number
    assert gate(None, 11.2) == (None, None)
    assert gate(-9.0, None) == (None, None)
    # NaN fails every comparison, so the gate closes on it
    assert gate(float("nan"), 11.2) == (None, None)


def test_quiet_real_audio_passes_even_when_the_window_was_wrong():
    # -55.7 LUFS is a valid measurement of near-silent content (a classical outro, the
    # silent tail of a file), so the gate passes it. Where a reading is quiet because the
    # window landed in silence, the window is what moves, never the gate.
    assert gate(-55.7, 11.8) == (-55.7, 11.8)


def test_range_beyond_whole_scale_is_nulled():
    # R128 is defined over the audible scale; a range past 60 LU is the meter lost
    assert gate(-9.0, 61.0) == (None, None)
