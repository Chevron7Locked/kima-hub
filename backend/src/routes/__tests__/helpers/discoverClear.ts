import express from "express";
import net from "node:net";
import discoverRoutes from "../../discover";

/** A TCP port nothing listens on: opens a server on a free port, reads the port, closes it. */
export async function deadPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const assigned = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolve(assigned));
        });
    });
}

/** The discover router mounted at /discover. */
export function discoverApp() {
    const a = express();
    a.use(express.json());
    a.use("/discover", discoverRoutes);
    return a;
}
