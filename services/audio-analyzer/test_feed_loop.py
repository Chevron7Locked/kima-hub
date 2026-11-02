"""The analysis loop keeps every worker busy and tags each report with the job it answers."""
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

import analyzer


class FakeRedis:
    """The queue is `queue`; every other list (the processing lists) is in `lists`."""

    def __init__(self, jobs):
        self.queue = [json.dumps(j) for j in jobs]
        self.lists = {}
        self.values = {}
        self.published = []
        self.lock = threading.Lock()

    def _list(self, key):
        return self.queue if key == analyzer.ANALYSIS_QUEUE else self.lists.setdefault(key, [])

    def lmove(self, src, dst, wherefrom, whereto):
        with self.lock:
            source = self._list(src)
            if not source:
                return None
            value = source.pop(0 if wherefrom == "LEFT" else -1)
            target = self._list(dst)
            target.insert(0 if whereto == "LEFT" else len(target), value)
            return value

    def blmove(self, src, dst, _timeout, wherefrom, whereto):
        return self.lmove(src, dst, wherefrom, whereto)

    def lrem(self, key, _count, value):
        with self.lock:
            items = self._list(key)
            if value in items:
                items.remove(value)
                return 1
            return 0

    def lrange(self, key, _start, _end):
        with self.lock:
            return list(self._list(key))

    def lpush(self, key, *values):
        with self.lock:
            for value in values:
                self._list(key).insert(0, value)

    def pipeline(self):
        return FakePipeline(self)

    def get(self, _key):
        return None

    def set(self, key, value, ex=None):
        self.values[key] = value

    def exists(self, key):
        return int(key in self.values)

    def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)

    def scan_iter(self, match=None):
        prefix = (match or "").rstrip("*")
        return [k for k in list(self.lists) if k.startswith(prefix)]

    def publish(self, _channel, message):
        self.published.append(json.loads(message))


class FakePipeline:
    def __init__(self, r):
        self.r, self.calls = r, []

    def __getattr__(self, name):
        return lambda *a: self.calls.append((name, a))

    def execute(self):
        for name, args in self.calls:
            getattr(self.r, name)(*args)


class FakeCursor:
    rowcount = 1

    def __init__(self, db):
        self.db = db
        self.rows = []

    def execute(self, sql, params=None):
        if 'FOR SHARE' in sql:
            track, attempt, redelivered = params[0], params[3], params[4]
            self.rows = [{"held": 1}] if self.db.open_claims.get(track) == (attempt, redelivered) else []
        elif 'FROM "TrackStage"' in sql:
            self.rows = [{"trackId": t, "attempt": a, "redelivered": r}
                         for t, (a, r) in self.db.open_claims.items() if t in params[2]]

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def close(self):
        pass


class FakeDb:
    def __init__(self, open_claims=None):
        # trackId -> (attempt, redelivered) of the record's open claim; by default every job's own.
        self.open_claims = open_claims

    def get_cursor(self):
        return FakeCursor(self)

    def commit(self):
        pass

    def rollback(self):
        pass


FEATURES: dict = {k: 0.5 for k in ("bpm", "beatsCount", "keyStrength", "energy", "loudness", "dynamicRange",
                             "danceability", "valence", "arousal")}
FEATURES.update(key="C", keyScale="major", essentiaGenres=[], analysisMode="enhanced")


def claim(job_id):
    attempt, redelivered = analyzer.CLAIM_IN_JOB_ID.search(job_id).groups()
    return int(attempt), int(redelivered)


def make_worker(jobs, workers, monkeypatch, run):
    monkeypatch.setattr(analyzer, "NUM_WORKERS", workers)
    monkeypatch.setattr(analyzer, "ProcessPoolExecutor", lambda **kw: ThreadPoolExecutor(kw["max_workers"]))
    monkeypatch.setattr(analyzer, "_analyze_track_in_process", run)
    w = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    w.redis = FakeRedis(jobs)
    w.instance = "this-process"
    w.processing_key = analyzer.PROCESSING_PREFIX + w.instance
    w._last_recover = 0.0
    w.db = FakeDb({j["trackId"]: claim(j["jobId"]) for j in jobs if j.get("jobId")})
    w.executor = None
    w.pool_active = False
    w._in_flight = {}
    w.musicnn_server = None
    w._gpu_server = None
    return w


def drain(w, seconds=5.0):
    end = time.time() + seconds
    while time.time() < end and (w.redis.queue or w._in_flight):
        w._fill()
        w._collect(timeout=0.05)


def test_a_slow_track_does_not_hold_up_the_others(monkeypatch):
    finished = {}

    def run(args):
        track_id, path = args
        time.sleep(0.6 if track_id == "slow" else 0.05)
        finished[track_id] = time.time()
        return track_id, path, dict(FEATURES)

    jobs = [{"trackId": "slow", "filePath": "/m/slow", "jobId": "slow-1-r0"}]
    jobs += [{"trackId": f"t{i}", "filePath": f"/m/{i}", "jobId": f"t{i}-1-r0"} for i in range(9)]
    w = make_worker(jobs, 4, monkeypatch, run)
    drain(w)
    shorts = [finished[f"t{i}"] for i in range(9)]
    assert max(shorts) < finished["slow"], "short tracks waited for the slow one"


def test_never_more_jobs_running_than_workers(monkeypatch):
    running, peak, lock = [0], [0], threading.Lock()

    def run(args):
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        time.sleep(0.03)
        with lock:
            running[0] -= 1
        return args[0], args[1], dict(FEATURES)

    jobs = [{"trackId": f"t{i}", "filePath": f"/m/{i}", "jobId": f"t{i}-1-r0"} for i in range(20)]
    w = make_worker(jobs, 3, monkeypatch, run)
    drain(w)
    assert peak[0] == 3


def test_reports_carry_the_job_they_answer(monkeypatch):
    def run(args):
        if args[0] == "bad":
            return args[0], args[1], {"_error": "decode failed"}
        return args[0], args[1], dict(FEATURES)

    jobs = [{"trackId": "good", "filePath": "/m/g", "jobId": "good-3-r1"},
            {"trackId": "bad", "filePath": "/m/b", "jobId": "bad-2-r0"}]
    w = make_worker(jobs, 2, monkeypatch, run)
    drain(w)
    by_track = {e["trackId"]: e for e in w.redis.published}
    assert by_track["good"] == {"trackId": "good", "jobId": "good-3-r1", "status": "complete"}
    assert by_track["bad"]["jobId"] == "bad-2-r0"
    assert by_track["bad"]["status"] == "failed"


def test_live_resize_reaches_the_machines_cores(monkeypatch):
    class Bus:
        def get_message(self, **_kw):
            return {"type": "message", "data": json.dumps({"command": "set_workers", "count": 64})}

    monkeypatch.setattr(analyzer, "NUM_WORKERS", 2)
    monkeypatch.setattr(analyzer.os, "cpu_count", lambda: 12)
    w = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    w.pubsub = Bus()
    w._pending_resize = None
    w._check_control_signals()
    assert w._pending_resize == 12


def test_a_job_whose_claim_was_reissued_is_not_analysed(monkeypatch):
    analysed = []

    def run(args):
        analysed.append(args[0])
        return args[0], args[1], dict(FEATURES)

    jobs = [{"trackId": "old", "filePath": "/m/old", "jobId": "old-1-r0"},
            {"trackId": "new", "filePath": "/m/new", "jobId": "new-2-r0"}]
    w = make_worker(jobs, 2, monkeypatch, run)
    w.db.open_claims["old"] = (2, 0)
    monkeypatch.setattr(w, "_save_results", lambda job, features: None)
    drain(w)
    assert analysed == ["new"]


def test_a_failed_claim_lookup_puts_the_jobs_back_in_order(monkeypatch):
    jobs = [{"trackId": t, "filePath": f"/m/{t}", "jobId": f"{t}-1-r0"} for t in ("a", "b", "c")]
    w = make_worker(jobs, 4, monkeypatch, lambda args: None)

    def boom(_jobs):
        raise RuntimeError("server closed the connection unexpectedly")

    monkeypatch.setattr(w, "_current_claims", boom)
    with pytest.raises(RuntimeError):
        w._fill()
    assert [json.loads(x)["trackId"] for x in w.redis.queue] == ["a", "b", "c"]
    assert w.redis.lists[w.processing_key] == [], "a job put back stayed on the processing list"


def test_a_changed_gpu_switch_finishes_the_running_track_takes_nothing_new_and_stops(monkeypatch):
    running, release = threading.Event(), threading.Event()

    def run(args):
        running.set()
        release.wait(5)
        return args[0], args[1], dict(FEATURES)

    jobs = [{"trackId": f"t{i}", "filePath": f"/m/{i}", "jobId": f"t{i}-1-r0"} for i in range(4)]
    w = make_worker(jobs, 1, monkeypatch, run)
    beats = []
    w.redis.set = lambda key, value, ex=None: beats.append((key, time.time()))
    w.db.connect = w.db.close = lambda: None
    w._check_control_signals = w._apply_pending_resize = lambda: None
    w._is_gate_closed = lambda: False
    w.is_paused, w.pubsub, w._restarting, w.consecutive_errors = False, None, False, 0
    w._last_work_time = time.time()
    switched = [False]
    monkeypatch.setattr(analyzer.gpu_switch, "restart_needed", lambda switch: switched[0])

    loop = threading.Thread(target=w.start)
    loop.start()
    assert running.wait(5)
    switched[0] = True
    changed = time.time()
    time.sleep(0.3)
    release.set()
    loop.join(10)
    assert any(key == "audio:worker:heartbeat" and at > changed for key, at in beats), "no heartbeat while finishing"

    assert not loop.is_alive(), "the worker kept running after the switch changed"
    assert [e["trackId"] for e in w.redis.published] == ["t0"]
    assert len(w.redis.queue) == 3, "it took new tracks after the switch changed"


def test_a_job_stays_on_the_processing_list_until_it_is_answered(monkeypatch):
    held = []

    def run(args):
        held.append([json.loads(x)["trackId"] for x in w.redis.lists.get(w.processing_key, [])])
        time.sleep(0.05)
        return args[0], args[1], dict(FEATURES)

    jobs = [{"trackId": f"t{i}", "filePath": f"/m/{i}", "jobId": f"t{i}-1-r0"} for i in range(3)]
    w = make_worker(jobs, 3, monkeypatch, run)
    drain(w)
    assert any(set(h) == {"t0", "t1", "t2"} for h in held), "the running jobs were not on the processing list"
    assert w.redis.lists[w.processing_key] == [], "answered jobs were left on the processing list"


def test_a_job_whose_claim_was_reissued_leaves_the_processing_list(monkeypatch):
    jobs = [{"trackId": "a", "filePath": "/m/a", "jobId": "a-1-r0"}]
    w = make_worker(jobs, 1, monkeypatch, lambda args: (args[0], args[1], dict(FEATURES)))
    w.db.open_claims = {"a": (1, 1)}
    w._fill()
    assert w.redis.lists[w.processing_key] == []


def test_a_job_whose_save_fails_still_leaves_the_processing_list(monkeypatch):
    jobs = [{"trackId": "a", "filePath": "/m/a", "jobId": "a-1-r0"}]
    w = make_worker(jobs, 1, monkeypatch, lambda args: (args[0], args[1], dict(FEATURES)))

    def broken_save(_future, _job):
        raise RuntimeError("database went away")

    monkeypatch.setattr(w, "_finish", broken_save)
    w._fill()
    with pytest.raises(RuntimeError):
        for _ in range(50):
            w._collect(timeout=0.05)
    assert w.redis.lists[w.processing_key] == []


def test_an_entry_that_is_not_a_job_is_dropped_and_the_rest_are_taken(monkeypatch):
    w = make_worker([{"trackId": "a", "filePath": "/m/a", "jobId": "a-1-r0"}], 2, monkeypatch, lambda args: None)
    w.redis.queue.insert(0, "not json")
    jobs = w._take_jobs(2, block=False)
    assert [j["trackId"] for j in jobs] == ["a"]
    assert [json.loads(x)["trackId"] for x in w.redis.lists[w.processing_key]] == ["a"]


def test_a_failure_partway_through_taking_puts_the_taken_jobs_back(monkeypatch):
    jobs = [{"trackId": t, "filePath": f"/m/{t}", "jobId": f"{t}-1-r0"} for t in ("a", "b", "c")]
    w = make_worker(jobs, 3, monkeypatch, lambda args: None)
    real, calls = w.redis.lmove, [0]

    def flaky(*args):
        calls[0] += 1
        moved = real(*args)
        if calls[0] == 2:
            raise ConnectionError("socket timeout after the move")
        return moved

    w.redis.lmove = flaky
    with pytest.raises(ConnectionError):
        w._take_jobs(3, block=False)
    assert [json.loads(x)["trackId"] for x in w.redis.queue] == ["a", "b", "c"]
    assert w.redis.lists[w.processing_key] == []


def test_the_loop_puts_a_stopped_process_jobs_back(monkeypatch):
    w = make_worker([], 1, monkeypatch, lambda args: None)
    w.redis.lists[analyzer.PROCESSING_PREFIX + "stopped"] = [json.dumps({"trackId": "x", "jobId": "x-1-r0"})]
    w.db.connect = w.db.close = lambda: None
    w.is_paused, w.pubsub, w._restarting, w.consecutive_errors = False, None, False, 0
    w._last_work_time = time.time()
    monkeypatch.setattr(analyzer.gpu_switch, "restart_needed", lambda switch: True)
    w.start()
    assert [json.loads(x)["trackId"] for x in w.redis.queue] == ["x"]
    assert ("audio:analysis:alive:this-process" not in w.redis.values), "a stopped process kept its alive key"


def test_setting_the_running_count_withdraws_a_queued_resize(monkeypatch):
    class Bus:
        def __init__(self, counts):
            self.counts = list(counts)

        def get_message(self, **_kw):
            return {"type": "message", "data": json.dumps({"command": "set_workers", "count": self.counts.pop(0)})}

    monkeypatch.setattr(analyzer, "NUM_WORKERS", 2)
    monkeypatch.setattr(analyzer.os, "cpu_count", lambda: 12)
    w = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    w.pubsub = Bus([6, 2])
    w._pending_resize = None
    w._check_control_signals()
    assert w._pending_resize == 6
    w._check_control_signals()
    assert w._pending_resize is None


def test_idle_passes_do_not_count_toward_the_error_recovery(monkeypatch):
    """Recovery (reconnecting the database) follows five errors in a row; idle passes between them do not count."""
    class Db:
        """Counts connects: one when the worker starts, one more for each recovery."""
        connects = 0

        def connect(self):
            Db.connects += 1

        def close(self):
            pass

    class Heartbeat:
        def set(self, *_a):
            pass

    def passes(outcomes):
        def fill():
            outcome = outcomes.pop(0)
            if outcome == "error":
                raise RuntimeError("redis hiccup")
            if not outcomes:
                w.running = False
            return outcome == "work"
        return fill

    monkeypatch.setattr(analyzer, "BRPOP_TIMEOUT", 0)
    monkeypatch.setattr(analyzer.time, "sleep", lambda _s: None)  # the recovery path's real 2 s pause
    monkeypatch.setattr(analyzer, "MODEL_IDLE_TIMEOUT", 0)
    monkeypatch.setattr(analyzer.gpu_switch, "restart_needed", lambda _for: False)
    w = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    w.redis, w.db, w.pubsub = Heartbeat(), Db(), None
    w._restarting, w.is_paused, w._in_flight, w.pool_active, w.consecutive_errors = False, False, {}, False, 0
    w._last_work_time = time.time()
    for name in ("_check_control_signals", "_apply_pending_resize", "_is_gate_closed", "_shutdown_pool"):
        monkeypatch.setattr(w, name, lambda *a, **k: None)
    monkeypatch.setattr(w, "_collect", lambda timeout=0: None)

    # Six idle passes, then one error: no recovery.
    monkeypatch.setattr(w, "_fill", passes(["idle"] * 6 + ["error", "idle"]))
    w.start()
    assert Db.connects == 1

    # Errors separated by idle passes never add up: an idle pass ends a run of errors as much as work does.
    Db.connects = 0
    monkeypatch.setattr(w, "_fill", passes(["error", "idle"] * 5 + ["idle"]))
    w.start()
    assert Db.connects == 1

    # Errors separated by good passes never add up either; five in a row do.
    monkeypatch.setattr(w, "_fill", passes(["error", "work"] * 4 + ["error"] * 5 + ["idle"]))
    Db.connects = 0
    w.start()
    assert Db.connects == 2
