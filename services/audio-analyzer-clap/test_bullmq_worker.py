"""The analyzer's job worker on the real bullmq binding and real Redis (REDIS_URL, else this checkout's test Redis).
Queued jobs run through the analyzer's own handler with real bullmq Job objects: a song that embeds completes with
the handler's reply and its progress at 100, and a song whose file is missing fails with the reason the handler
gives. The database, the CLAP model and the backend reports are stand-ins; nothing else is."""
import asyncio
import importlib.util
import os
import threading
import uuid
from unittest import mock

import numpy as np
import pytest
import redis
from bullmq import Job, Queue

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6390")


@pytest.fixture
def analyzer(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location("clap_analyzer_bullmq", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "REDIS_URL", REDIS_URL)
    monkeypatch.setattr(module, "VIBE_QUEUE_NAME", f"kima-test-vibe-{uuid.uuid4().hex}")
    song = tmp_path / "artist" / "album" / "song.flac"
    song.parent.mkdir(parents=True)
    song.write_bytes(b"flac")
    monkeypatch.setattr(module, "MUSIC_PATH", str(tmp_path))
    yield module
    client = redis.from_url(REDIS_URL)
    keys = list(client.scan_iter(f"bull:{module.VIBE_QUEUE_NAME}:*"))
    if keys:
        client.delete(*keys)


def make_worker(analyzer):
    model = mock.Mock()
    model.get_audio_embedding.return_value = np.ones(512)
    model.detect_vocals.return_value = 0.1
    model.detect_acousticness.return_value = 0.2
    model.detect_emotion.return_value = (0.25, 0.75)
    worker = analyzer.BullMQVibeWorker(analyzer=model, stop_event=threading.Event(), concurrency=2)
    worker._claim_is_current = mock.Mock(return_value=True)
    worker._store_result = mock.Mock(return_value="stored")
    worker._report_success = mock.Mock()
    worker._report_failure = mock.Mock()
    return worker


async def _run_jobs(analyzer, worker):
    queue = Queue(analyzer.VIBE_QUEUE_NAME, {"connection": REDIS_URL})
    ok = await queue.add("embed", {"trackId": "t1", "filePath": "artist/album/song.flac"})
    missing = await queue.add("embed", {"trackId": "t2", "filePath": "artist/album/gone.flac"}, {"attempts": 1})
    bullmq_worker = worker.build_worker(2)
    counts = {}
    try:
        for _ in range(100):
            counts = await queue.getJobCounts("completed", "failed")
            if counts.get("completed") == 1 and counts.get("failed") == 1:
                break
            await asyncio.sleep(0.1)
        return counts, await Job.fromId(queue, ok.id), await Job.fromId(queue, missing.id), ok.id, missing.id
    finally:
        await bullmq_worker.close()
        await queue.close()


def test_queued_jobs_run_through_the_analyzer_handler(analyzer):
    worker = make_worker(analyzer)
    counts, done, failed, ok_id, missing_id = asyncio.run(_run_jobs(analyzer, worker))

    assert counts == {"completed": 1, "failed": 1}
    assert done.returnvalue == {"trackId": "t1", "status": "complete"}
    assert done.progress == 100
    worker._report_success.assert_called_once_with(ok_id, "t1")
    assert sorted(c.args for c in worker._claim_is_current.call_args_list) == sorted([("t1", ok_id), ("t2", missing_id)])
    stored = worker._store_result.call_args.args
    assert stored[0] == "t1" and stored[2:] == (0.1, 0.2, 0.25, 0.75, ok_id)
    assert np.array_equal(stored[1], np.ones(512))

    assert failed.failedReason.startswith("[Errno 2]")
    worker._report_failure.assert_called_once_with(missing_id, "t2", "File not found: artist/album/gone.flac")
    assert worker._jobs_in_flight == 0
