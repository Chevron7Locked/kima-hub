"""Waiting for work on an empty queue, against real Redis (REDIS_URL, else this checkout's test Redis).

Each test waits on a queue of its own and treats the analyzer as open, so it writes nothing another user of the
same Redis reads.
"""
import os
import threading
import time
import uuid

import redis

import analyzer

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6390")


def worker_on_own_queue(monkeypatch):
    queue = f"test:analysis:{uuid.uuid4().hex}"
    monkeypatch.setattr(analyzer, "REDIS_URL", REDIS_URL)
    monkeypatch.setattr(analyzer, "ANALYSIS_QUEUE", queue)
    worker = analyzer.AnalysisWorker()
    monkeypatch.setattr(worker, "_is_gate_closed", lambda: False)
    return worker, queue


def test_an_empty_queue_waits_the_full_time_and_returns_nothing(monkeypatch):
    worker, _ = worker_on_own_queue(monkeypatch)

    started = time.monotonic()
    assert worker._take_jobs(1, block=True) == []
    # The wait ends on the server's answer, not on the client giving up first.
    assert time.monotonic() - started >= analyzer.BRPOP_TIMEOUT - 0.5


def test_a_job_pushed_during_the_wait_is_taken(monkeypatch):
    worker, queue = worker_on_own_queue(monkeypatch)
    pusher = threading.Timer(1.0, lambda: redis.from_url(REDIS_URL).rpush(queue, '{"trackId": "t1", "filePath": "/music/t1.flac"}'))
    pusher.start()
    try:
        assert [job["trackId"] for job in worker._take_jobs(1, block=True)] == ["t1"]
    finally:
        pusher.cancel()
