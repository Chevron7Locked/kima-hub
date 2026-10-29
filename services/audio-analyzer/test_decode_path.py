"""The real ``analyzer._decode_to_stereo``: one ffmpeg command reads the middle
90 s, tolerates bad frames, downmixes to stereo and reads any codec. Fixtures
(6-channel eac3 and aac, opus, corrupt mp3, 150 s) are generated with ffmpeg."""

import os
import shutil
import subprocess

import numpy as np
import pytest

import analyzer

FFMPEG = shutil.which("ffmpeg")

pytestmark = pytest.mark.skipif(
    FFMPEG is None, reason="ffmpeg not installed on this machine"
)

# The contract under test: one call returns the decoded window plus the
# evidence to record with it:
#   (samples, sample_rate, channels, duration, command, rc, stderr, class)


def _decode(path, duration=90):
    return analyzer._decode_to_stereo(path, duration=duration)


def _ffmpeg_generate(args, out_path):
    """Run ffmpeg to synthesize a fixture; returns the path."""
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"] + args,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, f"fixture generation failed: {proc.stderr}"
    return out_path


@pytest.fixture(scope="module")
def eac3_6ch(tmp_path_factory):
    """6-channel E-AC3: more than two channels, which must downmix to stereo."""
    path = tmp_path_factory.mktemp("fixtures") / "surround.mkv"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i",
            "aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*480*t)"
            "|0.3*sin(2*PI*520*t)|0.3*sin(2*PI*560*t)"
            "|0.3*sin(2*PI*600*t)|0.3*sin(2*PI*640*t)"
            ":duration=4:channel_layout=5.1",
            "-c:a", "eac3",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def aac_6ch_m4a(tmp_path_factory):
    """6-channel AAC in an m4a container. ffmpeg cannot mux eac3 into m4a, so AAC carries the
    container and the channel count."""
    path = tmp_path_factory.mktemp("fixtures") / "six.m4a"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i",
            "aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*480*t)"
            "|0.3*sin(2*PI*520*t)|0.3*sin(2*PI*560*t)"
            "|0.3*sin(2*PI*600*t)|0.3*sin(2*PI*640*t)"
            ":duration=4:channel_layout=5.1",
            "-c:a", "aac", "-b:a", "192k",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def opus_file(tmp_path_factory):
    """Opus: must decode through the same single path."""
    path = tmp_path_factory.mktemp("fixtures") / "opus.ogg"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=3",
            "-c:a", "libopus",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def long_file(tmp_path_factory):
    """150 seconds: 30 s of silence, 90 s of tone, 30 s of silence (a fade-out or a hidden-track gap).
    Only the middle 90 s may be read."""
    path = tmp_path_factory.mktemp("fixtures") / "long.flac"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i", "aevalsrc='if(between(t,30,120),0.5*sin(2*PI*440*t),0)':d=150",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def split_tone_file(tmp_path_factory):
    """440 Hz on the left, 880 Hz on the right: each channel must come back
    as its own tone, not two halves of the song."""
    path = tmp_path_factory.mktemp("fixtures") / "split.flac"
    return _ffmpeg_generate(
        [
            "-filter_complex",
            "sine=frequency=440:duration=3[l];sine=frequency=880:duration=3[r];"
            "[l][r]join=inputs=2:channel_layout=stereo",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def mono_file(tmp_path_factory):
    """A one-channel file at a known level: amplitude 0.5."""
    path = tmp_path_factory.mktemp("fixtures") / "mono.flac"
    return _ffmpeg_generate(
        ["-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*440*t):duration=3", "-ac", "1", str(path)],
        str(path),
    )


def _peak_hz(channel, sr):
    spectrum = np.abs(np.fft.rfft(channel))
    return float(np.fft.rfftfreq(len(channel), 1 / sr)[np.argmax(spectrum)])


@pytest.fixture
def corrupt_file(tmp_path_factory):
    """A valid mp3 with its middle overwritten by garbage bytes: the decode must still return
    samples, not reject the track."""
    path = tmp_path_factory.mktemp("fixtures") / "corrupt.mp3"
    _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=8",
            "-c:a", "libmp3lame",
            str(path),
        ],
        str(path),
    )
    with open(path, "r+b") as fh:
        fh.seek(4096)
        fh.write(bytes(range(256)) * 16)  # guaranteed-garbage middle
    assert os.path.getsize(str(path)) > 4096
    return str(path)


class TestSingleDecodePath:
    def test_decodes_6ch_eac3(self, eac3_6ch):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            eac3_6ch
        )
        assert channels == 2, f"expected stereo downmix, got {channels}ch"
        assert samples.shape[0] == 2
        assert duration > 3.0, f"expected ~4s decoded, got {duration}"
        assert rc == 0, f"decode returned {rc}: {stderr}"
        assert np.isfinite(samples).all()
        # A real decode must produce real signal, not silence-filled junk.
        assert np.abs(samples).max() > 0.01

    def test_decodes_opus(self, opus_file):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            opus_file
        )
        assert channels <= 2
        assert duration > 2.0, f"expected ~3s decoded, got {duration}"
        assert rc == 0, f"decode returned {rc}: {stderr}"
        assert np.isfinite(samples).all()

    def test_tolerates_bad_frame(self, corrupt_file):
        # A corrupt frame must not stop the analysis: the decode still yields samples covering the file.
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            corrupt_file
        )
        assert duration > 5.0, (
            f"corrupt file yielded only {duration}s — expected tolerance"
        )
        assert np.isfinite(samples).all()
        # Whatever the classifier says, the decode itself must not have
        # aborted: samples exist and the window was read.
        assert cls in ("DAMAGED", "UNSUPPORTED", "MULTICANNEL",
                       "INCONCLUSIVE")

    def test_downmixes_more_than_two_channels(self, eac3_6ch, aac_6ch_m4a):
        for path in (eac3_6ch, aac_6ch_m4a):
            samples, sr, channels, duration, command, rc, stderr, cls = (
                _decode(path)
            )
            assert channels == 2, (
                f"{path}: 6-channel input must downmix to stereo, "
                f"got {channels}"
            )
            assert samples.shape[0] == 2
            assert duration > 3.0

    def test_keeps_left_and_right_apart(self, split_tone_file):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            split_tone_file
        )
        assert rc == 0, f"decode returned {rc}: {stderr}"
        assert abs(_peak_hz(samples[0], sr) - 440) < 2
        assert abs(_peak_hz(samples[1], sr) - 880) < 2
        assert samples.flags["C_CONTIGUOUS"] and samples.dtype == np.float32

    def test_keeps_a_mono_file_at_its_own_level(self, mono_file):
        # ffmpeg's upmix to stereo lowers each channel by 3 dB (0.707); the
        # analysis must see the file's true level.
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(mono_file)
        assert rc == 0, f"decode returned {rc}: {stderr}"
        assert channels == 1 and samples.shape[0] == 1
        assert abs(float(np.max(np.abs(samples[0]))) - 0.5) < 0.01

    def test_reads_the_middle_90_seconds(self, long_file):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            long_file
        )
        assert rc == 0, f"decode returned {rc}: {stderr}"
        # A 150 s file yields its middle ~90 s: all of it tone, none of the
        # silence at either end, and never the whole file.
        assert 89.0 <= duration <= 90.5, (
            f"expected a 90s window, got {duration}s"
        )
        assert samples.shape[1] <= int(90.5 * sr)
        second_rms = np.sqrt((samples[0][: int(duration) * sr].reshape(-1, sr) ** 2).mean(axis=1))
        assert second_rms.min() > 0.1, "the window reached into the silence at an end"

    def test_a_song_shorter_than_the_window_is_read_whole(self, opus_file):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(opus_file)
        assert duration > 2.0
        assert "-ss" not in command

    def test_single_command_per_decode(self, opus_file):
        # One command, recorded verbatim — the caller must be able to
        # reproduce the decode from the recorded argv.
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            opus_file
        )
        assert isinstance(command, (list, tuple))
        assert str(command[0]).endswith("ffmpeg")
        assert "-err_detect" in command, (
            "decode must tolerate bad frames via -err_detect ignore_err"
        )
        assert "-xerror" not in command, (
            "-xerror would abort on the first bad frame — the opposite "
            "of tolerant"
        )


class TestWhenTheLengthLies:
    def _tone_only(self, samples, sr):
        second_rms = np.sqrt((samples[0][: (samples.shape[1] // sr) * sr].reshape(-1, sr) ** 2).mean(axis=1))
        return second_rms.min() > 0.1

    def test_an_unreadable_length_still_gives_the_middle_90_seconds(self, long_file, monkeypatch):
        monkeypatch.setattr(analyzer, "_source_stream", lambda path: (1, None))
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(long_file)
        assert 89.0 <= duration <= 90.5, f"expected a 90s window, got {duration}s"
        assert self._tone_only(samples, sr), "the window reached into the silence at an end"

    def test_a_header_longer_than_the_audio_still_gives_its_real_middle(self, long_file, monkeypatch):
        # A cut-short download: the header claims more than the file holds (150 s). At 300 s the first
        # seek lands inside the audio; at 400 s it lands past the real end.
        for header in (300.0, 400.0):
            monkeypatch.setattr(analyzer, "_source_stream", lambda path, h=header: (1, h))
            samples, sr, channels, duration, command, rc, stderr, cls = _decode(long_file)
            assert 89.0 <= duration <= 90.5, f"header {header}: expected a 90s window, got {duration}s"
            assert self._tone_only(samples, sr), f"header {header}: the window reached into the silence at an end"

    def test_a_header_shorter_than_the_audio_still_gives_its_real_middle(self, long_file, monkeypatch):
        # A header that understates the length (an estimate from the bitrate): 85 s and 120 s for 150 s.
        for header in (85.0, 120.0):
            monkeypatch.setattr(analyzer, "_source_stream", lambda path, h=header: (1, h))
            samples, sr, channels, duration, command, rc, stderr, cls = _decode(long_file)
            assert 89.0 <= duration <= 90.5, f"header {header}: expected a 90s window, got {duration}s"
            assert self._tone_only(samples, sr), f"header {header}: the window reached into the silence at an end"

def test_a_decode_failing_on_a_missing_codec_names_that_codec(monkeypatch):
    """The failure list shows the stage's error message, so an unsupported file says which codec it is."""
    stderr = "[dts @ 0x1] Decoder not found\nunsupported codec dts"
    monkeypatch.setattr(
        analyzer, "_decode_to_stereo",
        lambda *a, **k: (None, None, 0, None, ["ffmpeg"], 1, stderr, analyzer.classify_failure(stderr)),
    )
    monkeypatch.setattr(analyzer, "ESSENTIA_AVAILABLE", True)
    worker = analyzer.AudioAnalyzer.__new__(analyzer.AudioAnalyzer)
    assert worker.load_audio("/x.dts") is None
    assert worker._last_load_error.startswith("UNSUPPORTED::dts -- ")

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
