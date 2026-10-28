// Runs once after every worker has finished: closes the connection holding the run's lock on the test database
// (test-global-setup.cjs), which hands the database to the next run. A lock check still in flight finishes first, so
// closing the connection under it cannot fail a run that passed.
module.exports = async function globalTeardown() {
    globalThis.__kimaTestLockStopping = true;
    clearInterval(globalThis.__kimaTestLockCheck);
    delete globalThis.__kimaTestLockCheck;
    await globalThis.__kimaTestLockTick;
    const lock = globalThis.__kimaTestLock;
    if (!lock) return;
    try {
        await lock.$disconnect();
    } catch (err) {
        throw new Error(`The tests ran, but closing the connection that holds the test database lock failed: ${err.message}`);
    }
    delete globalThis.__kimaTestLock;
};
