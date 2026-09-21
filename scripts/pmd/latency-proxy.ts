/**
 * A tiny TCP proxy that delays every chunk in each direction, to measure how a workload behaves when the
 * database is not on localhost. Round trip = 2 x one-way delay: `oneWayMs: 10` simulates a 20 ms link.
 *
 * Local loopback hides the cost that dominates a hosted database (each SQL statement is a network round
 * trip), so throughput numbers taken on localhost say little about a cloud deployment. With this in front of
 * PostgreSQL the same benchmark shows what a loader really costs per round trip.
 *
 * Chunk order is preserved (timers of equal duration fire in order). Bandwidth is not limited.
 */
import net from "node:net";

export interface LatencyProxy {
  port: number;
  close(): Promise<void>;
}

export async function startLatencyProxy(opts: { targetHost: string; targetPort: number; oneWayMs: number }): Promise<LatencyProxy> {
  const sockets = new Set<net.Socket>();
  const pipeWithDelay = (from: net.Socket, to: net.Socket) => {
    from.on("data", (chunk) => {
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, opts.oneWayMs);
    });
    from.on("end", () => setTimeout(() => to.end(), opts.oneWayMs));
  };

  const server = net.createServer((client) => {
    const upstream = net.connect(opts.targetPort, opts.targetHost);
    for (const s of [client, upstream]) {
      s.setNoDelay(true);
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    pipeWithDelay(client, upstream);
    pipeWithDelay(upstream, client);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
