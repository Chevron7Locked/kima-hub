"""The in-flight count the CLAP worker publishes for its running jobs. The
backend's one-at-a-time rule reads clap:worker:inflight, so the count must be
published when a job starts and return to zero when the job ends — by success,
by failure, and by the claim-re-issued skip — a Redis write that fails must
not break the job, and every write expires in three heartbeats (a crashed
worker's count lapses on its own). A fresh worker publishes 0 when it starts,
before taking any job, so a previous process's leftover count is cleared on
restart."""
import asyncio
import threading
from unittest import mock

import numpy as np
import pytest

import analyzer

INFLIGHT_KEY = "clap:worker:inflight"


def make_worker(redis_client):
    # A stand-in analyzer: the job tuple-unpacks detect_emotion's pair, so the
    # stand-in answers with one. Configured before construction, on the mock.
    fake_analyzer = mock.Mock()
    fake_analyzer.detect_emotion.return_value = (0.5, 0.5)
    worker = analyzer.BullMQVibeWorker(analyzer=fake_analyzer, stop_event=threading.Event(), concurrency=1)
    worker._redis_client = redis_client
    return worker


def make_job(track_id="track-1"):
    job = mock.Mock()
    job.id = "job-1"
    job.data = {"trackId": track_id, "filePath": "artist/album/song.flac"}
    job.updateProgress = mock.AsyncMock()
    return job


def point_music_at(tmp_path, monkeypatch):
    """The job reads the file's size off disk, so the test's music root holds a real file."""
    song = tmp_path / "artist" / "album" / "song.flac"
    song.parent.mkdir(parents=True)
    song.write_bytes(b"flac")
    monkeypatch.setattr(analyzer, "MUSIC_PATH", str(tmp_path))


def published_values(redis_client):
    """Every value written to the inflight key, in order."""
    return [c.args[1] for c in redis_client.set.call_args_list if c.args[0] == INFLIGHT_KEY]


def test_counter_returns_to_zero_after_a_success(tmp_path, monkeypatch):
    point_music_at(tmp_path, monkeypatch)
    worker = make_worker(mock.Mock())
    job = make_job()
    worker._claim_is_current = mock.Mock(return_value=True)
    worker.analyzer.get_audio_embedding = mock.Mock(return_value=np.ones(512))
    worker._store_result = mock.Mock(return_value="stored")
    worker._report_success = mock.Mock()

    result = asyncio.run(worker._process_job(job, "token"))

    assert result == {"trackId": "track-1", "status": "complete"}
    assert worker._jobs_in_flight == 0
    # The count is published while the job runs (1) and lowered when it ends (0).
    assert published_values(worker._redis_client) == ["1", "0"]


def test_counter_returns_to_zero_after_a_failure(tmp_path, monkeypatch):
    point_music_at(tmp_path, monkeypatch)
    worker = make_worker(mock.Mock())
    job = make_job()
    worker._claim_is_current = mock.Mock(return_value=True)
    worker.analyzer.get_audio_embedding = mock.Mock(return_value=np.ones(512))
    worker._store_result = mock.Mock(return_value="failed")
    worker._report_failure = mock.Mock()

    with pytest.raises(RuntimeError):
        asyncio.run(worker._process_job(job, "token"))

    assert worker._jobs_in_flight == 0
    assert published_values(worker._redis_client) == ["1", "0"]


def test_counter_returns_to_zero_after_the_claim_skip():
    worker = make_worker(mock.Mock())
    job = make_job()
    worker._claim_is_current = mock.Mock(return_value=False)

    result = asyncio.run(worker._process_job(job, "token"))

    assert result == {"skipped": True}
    assert worker._jobs_in_flight == 0
    assert published_values(worker._redis_client) == ["1", "0"]


def inflight_writes(redis_client):
    """Every (value, expiry) written to the inflight key, in order."""
    return [
        (c.args[1], c.kwargs.get("ex"))
        for c in redis_client.set.call_args_list
        if c.args[0] == INFLIGHT_KEY
    ]


def test_a_beat_expires_the_inflight_count_after_three_heartbeats():
    # A count no live worker refreshes is gone after 3 heartbeats, so a stale
    # count is never what holds analysis back.
    redis_client = mock.Mock()
    worker = make_worker(redis_client)
    worker._active_concurrency = 2
    worker._jobs_in_flight = 1

    asyncio.run(worker._beat())

    expiry = 3 * analyzer.HEARTBEAT_SECONDS
    assert expiry == analyzer.INFLIGHT_TTL_SECONDS == 90
    assert inflight_writes(redis_client) == [("1", expiry)]


def test_a_publish_expires_the_inflight_count_after_three_heartbeats(tmp_path, monkeypatch):
    point_music_at(tmp_path, monkeypatch)
    # Job start and job end publish through _publish_inflight: both writes carry the
    # same expiry, so the count never sticks after a crash.
    redis_client = mock.Mock()
    worker = make_worker(redis_client)
    job = make_job()
    worker._claim_is_current = mock.Mock(return_value=True)
    worker.analyzer.get_audio_embedding = mock.Mock(return_value=np.ones(512))
    worker._store_result = mock.Mock(return_value="stored")
    worker._report_success = mock.Mock()

    asyncio.run(worker._process_job(job, "token"))

    expiry = 3 * analyzer.HEARTBEAT_SECONDS
    assert inflight_writes(redis_client) == [("1", expiry), ("0", expiry)]


def test_a_fresh_worker_publishes_zero_before_it_takes_a_job(monkeypatch):
    # A crashed worker's leftover count must not survive the restart: the new worker
    # publishes 0 when it starts, before BullMQ hands it any job.
    redis_client = mock.Mock()
    monkeypatch.setattr(analyzer.redis, "from_url", lambda url: redis_client)
    worker = make_worker(redis_client)
    worker._connect_pool = mock.Mock()
    bullmq_worker = mock.Mock()
    bullmq_worker.close = mock.AsyncMock()
    worker.build_worker = mock.Mock(return_value=bullmq_worker)
    worker.stop_event.set()  # the run loop exits right away: startup, then shutdown

    asyncio.run(worker._run())

    worker.build_worker.assert_called_once()  # the publish came before any worker was built
    writes = inflight_writes(redis_client)
    # The first thing a fresh worker writes to the key is a zeroed count with the
    # heartbeat expiry, and taking no job is what wrote it (a taken job logs a "1"
    # first). Shutdown beats repeat the zero — same value, same expiry.
    expiry = 3 * analyzer.HEARTBEAT_SECONDS
    assert ("1", expiry) not in writes
    assert writes[0] == ("0", expiry)


def test_a_missed_publish_does_not_break_the_job(tmp_path, monkeypatch):
    point_music_at(tmp_path, monkeypatch)
    # A Redis client that raises on every write (the analyzer keeps working
    # through a flapping connection; _beat makes up the missed write).
    broken = mock.Mock()
    broken.set.side_effect = ConnectionError("redis down")
    worker = make_worker(broken)
    job = make_job()
    worker._claim_is_current = mock.Mock(return_value=True)
    worker.analyzer.get_audio_embedding = mock.Mock(return_value=np.ones(512))
    worker._store_result = mock.Mock(return_value="stored")
    worker._report_success = mock.Mock()

    result = asyncio.run(worker._process_job(job, "token"))

    assert result == {"trackId": "track-1", "status": "complete"}
    assert worker._jobs_in_flight == 0


def test_a_concurrency_change_keeps_beating_while_running_jobs_finish(monkeypatch):
    # Replacing the worker waits for the jobs already running. While it waits the
    # worker must keep beating, so the in-flight count (which lapses after three
    # heartbeats) stays live for as long as a job is still working.
    redis_client = mock.Mock()
    monkeypatch.setattr(analyzer.redis, "from_url", lambda url: redis_client)
    monkeypatch.setattr(analyzer, "HEARTBEAT_SECONDS", 0.05)
    worker = make_worker(redis_client)
    worker._connect_pool = mock.Mock()
    worker._resize_pool = mock.Mock()

    during_close = []

    async def slow_close():
        before = len(published_values(redis_client))
        await asyncio.sleep(0.3)  # six heartbeats' worth of a job still running
        during_close.extend(published_values(redis_client)[before:])

    old = mock.Mock()
    old.close = mock.AsyncMock(side_effect=slow_close)
    new = mock.Mock()
    new.close = mock.AsyncMock()

    def build(concurrency):
        if concurrency == 1:
            worker.set_concurrency(2)  # an admin moves the slider once the worker runs
            return old
        worker.stop_event.set()  # the replacement is up: let the loop end
        return new

    worker.build_worker = mock.Mock(side_effect=build)
    worker._jobs_in_flight = 1

    asyncio.run(worker._run())

    old.close.assert_awaited_once()
    # Beats made while the old worker was closing carry the running job's count.
    assert during_close.count("1") >= 3
