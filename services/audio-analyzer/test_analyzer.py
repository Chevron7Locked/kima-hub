"""
Tests for analyzer.py optimistic locking on Track status updates.

Run with: cd /mnt/storage/Projects/lidify/services/audio-analyzer && python3 -m pytest test_analyzer.py -v
Or: cd /mnt/storage/Projects/lidify/services/audio-analyzer && python3 test_analyzer.py
"""

import unittest
import re
import os


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


if __name__ == '__main__':
    unittest.main()
