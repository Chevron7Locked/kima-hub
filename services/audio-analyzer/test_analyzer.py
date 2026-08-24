"""
Tests for analyzer.py optimistic locking on Track status updates.

Run with: cd /mnt/storage/Projects/lidify/services/audio-analyzer && python3 -m pytest test_analyzer.py -v
Or: cd /mnt/storage/Projects/lidify/services/audio-analyzer && python3 test_analyzer.py
"""

import unittest
import re
import os
import ast
import logging
import multiprocessing
import time
import types


def _sleep_for_teardown_test():
    time.sleep(30)


class TestAnalyzerOptimisticLocking(unittest.TestCase):
    """Structural tests verifying WHERE clause guards on Track updates."""

    @classmethod
    def setUpClass(cls):
        analyzer_path = os.path.join(os.path.dirname(__file__), 'analyzer.py')
        with open(analyzer_path, 'r') as f:
            cls.source = f.read()

    def _extract_method(self, method_name):
        """Extract a method body from the source."""
        pattern = rf'def {method_name}\(self.*?\n(    def |\nclass |\Z)'
        match = re.search(pattern, self.source, re.DOTALL)
        self.assertIsNotNone(match, f"Could not find method {method_name}")
        return match.group(0)

    def test_save_results_includes_status_guard(self):
        """_save_results UPDATE should include AND analysisStatus = 'processing'"""
        method = self._extract_method('_save_results')
        self.assertIn(
            '"analysisStatus" = \'processing\'',
            method,
            "_save_results UPDATE missing analysisStatus guard"
        )

    def test_save_results_checks_rowcount(self):
        """_save_results should check cursor.rowcount after UPDATE"""
        method = self._extract_method('_save_results')
        self.assertIn('rowcount', method, "_save_results missing rowcount check")

    def test_save_failed_includes_status_guard(self):
        """_save_failed UPDATE should include AND analysisStatus = 'processing'"""
        method = self._extract_method('_save_failed')
        self.assertIn(
            '"analysisStatus" = \'processing\'',
            method,
            "_save_failed UPDATE missing analysisStatus guard"
        )

    def test_save_failed_checks_rowcount(self):
        """_save_failed should check cursor.rowcount after UPDATE"""
        method = self._extract_method('_save_failed')
        self.assertIn('rowcount', method, "_save_failed missing rowcount check")


class FakeProcess:
    def __init__(self, survives_terminate=False):
        self.pid = 123
        self.alive = True
        self.survives_terminate = survives_terminate
        self.terminated = False
        self.killed = False
        self.join_timeouts = []

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.terminated = True
        if not self.survives_terminate:
            self.alive = False

    def kill(self):
        self.killed = True
        self.alive = False

    def join(self, timeout=None):
        self.join_timeouts.append(timeout)


class FakeExecutor:
    def __init__(self, processes):
        self._processes = {index: process for index, process in enumerate(processes)}
        self.shutdown_calls = []

    def shutdown(self, **kwargs):
        self.shutdown_calls.append(kwargs)


class CompatibleExecutor:
    """Simulate Python versions whose shutdown lacks cancel_futures."""

    def __init__(self):
        self.shutdown_calls = []

    def shutdown(self, **kwargs):
        self.shutdown_calls.append(kwargs)
        if 'cancel_futures' in kwargs:
            raise TypeError('cancel_futures is unsupported')


class TestForcedExecutorTeardown(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        analyzer_path = os.path.join(os.path.dirname(__file__), 'analyzer.py')
        with open(analyzer_path, 'r') as source_file:
            tree = ast.parse(source_file.read())
        names = {'PROCESS_TERMINATE_WAIT_SECONDS', 'PROCESS_KILL_WAIT_SECONDS'}
        nodes = [
            node for node in tree.body
            if (isinstance(node, ast.FunctionDef) and node.name == '_force_shutdown_executor')
            or (isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id in names
                for target in node.targets
            ))
        ]
        module = types.ModuleType('teardown_under_test')
        module.logger = logging.getLogger('teardown-test')
        exec(compile(ast.Module(body=nodes, type_ignores=[]), analyzer_path, 'exec'), module.__dict__)
        cls.teardown = staticmethod(module._force_shutdown_executor)

    def test_terminates_workers_and_cancels_queued_futures(self):
        process = FakeProcess()
        executor = FakeExecutor([process])

        self.teardown(executor)

        self.assertEqual(executor.shutdown_calls, [{'wait': False, 'cancel_futures': True}])
        self.assertTrue(process.terminated)
        self.assertFalse(process.killed)
        self.assertFalse(process.alive)
        self.assertTrue(all(timeout is not None for timeout in process.join_timeouts))

    def test_kills_worker_only_when_terminate_does_not_stop_it(self):
        process = FakeProcess(survives_terminate=True)

        self.teardown(FakeExecutor([process]))

        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertFalse(process.alive)

    def test_falls_back_when_cancel_futures_is_unsupported(self):
        executor = CompatibleExecutor()

        self.teardown(executor)

        self.assertEqual(executor.shutdown_calls, [
            {'wait': False, 'cancel_futures': True},
            {'wait': False},
        ])

    def test_executor_without_private_process_mapping_is_supported(self):
        executor = CompatibleExecutor()

        self.teardown(executor)

        self.assertEqual(executor.shutdown_calls[-1], {'wait': False})

    def test_terminates_real_worker_process(self):
        process = multiprocessing.Process(target=_sleep_for_teardown_test)
        process.start()
        self.addCleanup(lambda: process.kill() if process.is_alive() else None)

        self.teardown(FakeExecutor([process]))

        self.assertFalse(process.is_alive())
        self.assertIsNotNone(process.exitcode)

    def test_pool_helpers_reset_state(self):
        calls = []
        worker = types.SimpleNamespace(
            executor=FakeExecutor([]),
            scan_executor=FakeExecutor([]),
            pool_active=True,
        )

        def force_shutdown(executor):
            calls.append(executor)

        analyzer_path = os.path.join(os.path.dirname(__file__), 'analyzer.py')
        with open(analyzer_path, 'r') as source_file:
            tree = ast.parse(source_file.read())
        worker_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'AnalysisWorker')
        helpers = [
            node for node in worker_class.body
            if isinstance(node, ast.FunctionDef)
            and node.name in {'_force_shutdown_pool', '_force_shutdown_scan_pool'}
        ]
        module = types.ModuleType('pool_helpers_under_test')
        module._force_shutdown_executor = force_shutdown
        exec(compile(ast.Module(body=helpers, type_ignores=[]), analyzer_path, 'exec'), module.__dict__)

        module._force_shutdown_pool(worker)
        module._force_shutdown_scan_pool(worker)

        self.assertIsNone(worker.executor)
        self.assertIsNone(worker.scan_executor)
        self.assertFalse(worker.pool_active)
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
