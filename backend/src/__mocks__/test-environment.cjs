/**
 * The node test environment, closing the Prisma clients a test file opened once the file is finished. Its teardown
 * runs after every afterAll of the file, including the file's own cleanup, which queries (and so reconnects) after
 * any hook a setup file could register. clientReaper.cjs registers the clients as they are made.
 */
const { TestEnvironment } = require('jest-environment-node');

class KimaTestEnvironment extends TestEnvironment {
    async teardown() {
        const clients = this.global.__prismaClients ?? [];
        await Promise.all(clients.splice(0).map((client) => client.$disconnect().catch(() => {})));
        await super.teardown();
    }
}

module.exports = KimaTestEnvironment;
