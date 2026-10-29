"""Waiting for work on an empty queue, against real Redis (REDIS_URL, else this checkout's test Redis).

Each test waits on a queue of its own (deleted afterwards) and treats the analyzer as open, so it never touches the
real queue or the pause gate; the worker also subscribes to the control channel, read-only, until the test ends.
"""
import os
import threading
import time
import uuid

import pytest
import redis

import analyzer

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6390")


@pytest.fixture
def worker_on_own_queue(monkeypatch):
    queue = f"test:analysis:{uuid.uuid4().hex}"
    monkeypatch.setattr(analyzer, "REDIS_URL", REDIS_URL)
    monkeypatch.setattr(analyzer, "ANALYSIS_QUEUE", queue)
    worker = analyzer.AnalysisWorker()
    monkeypatch.setattr(worker, "_is_gate_closed", lambda: False)
    yield worker, queue
    if worker.pubsub:
        worker.pubsub.close()
    worker.redis.delete(queue)
    worker.redis.close()


def test_an_empty_queue_waits_the_full_time_and_returns_nothing(worker_on_own_queue):
    worker, _ = worker_on_own_queue

    started = time.monotonic()
    assert worker._take_jobs(1, block=True) == []
    # The wait ends on the server's answer, not on the client giving up first.
    assert time.monotonic() - started >= analyzer.BRPOP_TIMEOUT - 0.5


def test_a_job_pushed_during_the_wait_is_taken(worker_on_own_queue):
    worker, queue = worker_on_own_queue
    pusher_client = redis.from_url(REDIS_URL)
    pusher = threading.Timer(1.0, lambda: pusher_client.rpush(queue, '{"trackId": "t1", "filePath": "/music/t1.flac"}'))
    pusher.start()
    try:
        assert [job["trackId"] for job in worker._take_jobs(1, block=True)] == ["t1"]
    finally:
        pusher.cancel()
        pusher.join()
        pusher_client.close()
