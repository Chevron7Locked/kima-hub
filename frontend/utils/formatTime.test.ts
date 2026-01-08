/**
 * Unit tests for formatTime utility functions
 * Run with: npx tsx frontend/utils/formatTime.test.ts
 */

import {
    formatTime,
    formatDuration,
    clampTime,
    formatTimeRemaining,
} from "./formatTime";

// Test utilities
let passed = 0;
let failed = 0;

function assertEqual(actual: any, expected: any, testName: string) {
    if (actual === expected) {
        console.log(`✓ ${testName}`);
        passed++;
    } else {
        console.error(`✗ ${testName}`);
        console.error(`  Expected: ${expected}`);
        console.error(`  Actual: ${actual}`);
        failed++;
    }
}

console.log("\n=== Testing formatTime ===\n");

// Basic formatting
assertEqual(formatTime(0), "0:00", "formatTime(0) = 0:00");
assertEqual(formatTime(30), "0:30", "formatTime(30) = 0:30");
assertEqual(formatTime(60), "1:00", "formatTime(60) = 1:00");
assertEqual(formatTime(125), "2:05", "formatTime(125) = 2:05");
assertEqual(formatTime(3599), "59:59", "formatTime(3599) = 59:59");
assertEqual(formatTime(3600), "1:00:00", "formatTime(3600) = 1:00:00");
assertEqual(formatTime(3661), "1:01:01", "formatTime(3661) = 1:01:01");
assertEqual(formatTime(7325), "2:02:05", "formatTime(7325) = 2:02:05");

// Edge cases
assertEqual(formatTime(-1), "0:00", "formatTime(-1) = 0:00 (negative)");
assertEqual(formatTime(NaN), "0:00", "formatTime(NaN) = 0:00");
assertEqual(formatTime(Infinity), "0:00", "formatTime(Infinity) = 0:00");

console.log("\n=== Testing clampTime ===\n");

// Basic clamping - THE CRITICAL FIX
assertEqual(clampTime(0, 100), 0, "clampTime(0, 100) = 0");
assertEqual(clampTime(50, 100), 50, "clampTime(50, 100) = 50 (within bounds)");
assertEqual(
    clampTime(100, 100),
    100,
    "clampTime(100, 100) = 100 (at boundary)"
);
assertEqual(
    clampTime(150, 100),
    100,
    "clampTime(150, 100) = 100 (CRITICAL: clamp to duration)"
);
assertEqual(
    clampTime(3480, 3274),
    3274,
    "clampTime(3480, 3274) = 3274 (Office Ladies bug case)"
);

// Edge cases
assertEqual(
    clampTime(-5, 100),
    0,
    "clampTime(-5, 100) = 0 (negative clamp to 0)"
);
assertEqual(
    clampTime(50, 0),
    50,
    "clampTime(50, 0) = 50 (zero duration edge case)"
);
assertEqual(
    clampTime(-10, 0),
    0,
    "clampTime(-10, 0) = 0 (negative with zero duration)"
);

console.log("\n=== Testing formatTimeRemaining ===\n");

// Basic remaining time format
assertEqual(
    formatTimeRemaining(0),
    "0:00",
    "formatTimeRemaining(0) = 0:00 (complete)"
);
assertEqual(
    formatTimeRemaining(30),
    "-0:30",
    "formatTimeRemaining(30) = -0:30"
);
assertEqual(
    formatTimeRemaining(125),
    "-2:05",
    "formatTimeRemaining(125) = -2:05"
);
assertEqual(
    formatTimeRemaining(3600),
    "-1:00:00",
    "formatTimeRemaining(3600) = -1:00:00"
);
assertEqual(
    formatTimeRemaining(7325),
    "-2:02:05",
    "formatTimeRemaining(7325) = -2:02:05"
);

// Edge cases
assertEqual(
    formatTimeRemaining(-5),
    "0:00",
    "formatTimeRemaining(-5) = 0:00 (negative)"
);
assertEqual(
    formatTimeRemaining(NaN),
    "0:00",
    "formatTimeRemaining(NaN) = 0:00"
);

console.log("\n=== Testing formatDuration ===\n");

// Basic duration formatting
assertEqual(formatDuration(0), "0m", "formatDuration(0) = 0m");
assertEqual(formatDuration(60), "1m", "formatDuration(60) = 1m");
assertEqual(formatDuration(3600), "1h", "formatDuration(3600) = 1h");
assertEqual(formatDuration(5400), "1h 30m", "formatDuration(5400) = 1h 30m");

console.log("\n=== Integration Tests (Bug Scenarios) ===\n");

// Simulate the Office Ladies podcast bug
// Current time: 58:00 (3480 seconds), Duration: 54:34 (3274 seconds)
const podcastCurrentTime = 3480; // 58:00
const podcastDuration = 3274; // 54:34
const clampedTime = clampTime(podcastCurrentTime, podcastDuration);
assertEqual(
    clampedTime,
    podcastDuration,
    "Office Ladies bug: current time clamped to duration"
);
assertEqual(
    formatTime(clampedTime),
    "54:34",
    "Office Ladies bug: displays 54:34 not 58:00"
);

// Time remaining should show 0:00 when at end
const remaining = Math.max(0, podcastDuration - clampedTime);
assertEqual(
    formatTimeRemaining(remaining),
    "0:00",
    "Office Ladies bug: time remaining = 0:00 at end"
);

// Progress should be 100% max
const progress = Math.min(
    100,
    Math.max(0, (clampedTime / podcastDuration) * 100)
);
assertEqual(progress, 100, "Office Ladies bug: progress = 100% (not > 100%)");

// Test podcast in progress
const podcastInProgress = clampTime(1000, 3274);
const remainingInProgress = Math.max(0, 3274 - podcastInProgress);
assertEqual(
    formatTimeRemaining(remainingInProgress),
    "-37:54",
    "Podcast in progress: shows remaining time"
);

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50) + "\n");

if (failed > 0) {
    process.exit(1);
}
