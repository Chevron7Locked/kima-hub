"""A taken job waits on its process's own list until answered, and a stopped process's jobs go back to the head of the
queue unchanged, against real Redis (REDIS_URL, else this checkout's test Redis). Every key is the test's own."""
import json
import os
import uuid

import pytest
import redis

import analyzer

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6390")


@pytest.fixture
def worker(monkeypatch):
    tag = uuid.uuid4().hex
    monkeypatch.setattr(analyzer, "REDIS_URL", REDIS_URL)
    monkeypatch.setattr(analyzer, "ANALYSIS_QUEUE", f"test:queue:{tag}")
    monkeypatch.setattr(analyzer, "PROCESSING_PREFIX", f"test:processing:{tag}:")
    monkeypatch.setattr(analyzer, "ALIVE_PREFIX", f"test:alive:{tag}:")
    w = analyzer.AnalysisWorker()
    monkeypatch.setattr(w, "_is_gate_closed", lambda: False)
    yield w
    for key in w.redis.scan_iter(match=f"test:*{tag}*"):
        w.redis.delete(key)
    if w.pubsub:
        w.pubsub.close()
    w.redis.close()


def entry(track):
    return json.dumps({"trackId": track, "filePath": f"/music/{track}.flac", "jobId": f"track-{track}-analysis-1-r0"})


def test_a_taken_job_waits_on_this_process_list_until_it_is_done(worker):
    worker.redis.rpush(analyzer.ANALYSIS_QUEUE, entry("a"), entry("b"))
    jobs = worker._take_jobs(2, block=False)
    assert [j["trackId"] for j in jobs] == ["a", "b"]
    assert worker.redis.llen(analyzer.ANALYSIS_QUEUE) == 0
    assert worker.redis.lrange(worker.processing_key, 0, -1) == [entry("a").encode(), entry("b").encode()]
    worker._done_with(jobs[0])
    assert worker.redis.lrange(worker.processing_key, 0, -1) == [entry("b").encode()]


def test_a_stopped_process_jobs_go_back_to_the_head_of_the_queue_in_order(worker):
    stopped = analyzer.PROCESSING_PREFIX + "stopped"
    worker.redis.rpush(stopped, entry("x"), entry("y"))
    worker.redis.rpush(analyzer.ANALYSIS_QUEUE, entry("later"))
    assert worker._recover_stopped_processes() == 2
    assert worker.redis.lrange(analyzer.ANALYSIS_QUEUE, 0, -1) == [entry(t).encode() for t in ("x", "y", "later")]
    assert worker.redis.llen(stopped) == 0


def test_a_live_process_jobs_and_this_process_own_stay(worker):
    live = analyzer.PROCESSING_PREFIX + "live"
    worker.redis.rpush(live, entry("busy"))
    worker.redis.set(analyzer.ALIVE_PREFIX + "live", "1", ex=60)
    worker.redis.rpush(worker.processing_key, entry("mine"))
    assert worker._recover_stopped_processes() == 0
    assert worker.redis.lrange(live, 0, -1) == [entry("busy").encode()]
    assert worker.redis.lrange(worker.processing_key, 0, -1) == [entry("mine").encode()]
