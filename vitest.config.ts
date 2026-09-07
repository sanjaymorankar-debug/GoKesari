import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Integration tests share one PostgreSQL database, so they must not run in
    // parallel — concurrent truncation between files would corrupt fixtures.
    fileParallelism: false,
    // ...and they must share ONE worker. With a worker per file, a finished
    // file's connection stays idle holding AccessShareLock, which deadlocks the
    // next file's TRUNCATE. One worker means one connection pool, no deadlock.
    maxWorkers: 1,
    // The test database is remote (Neon, serverless), so every round trip
    // costs real latency and a single checkout test can spend 20-40s just
    // waiting on the network. 30s was tight enough that the multi-shop
    // tests — which do roughly twice the work — failed on the clock rather
    // than on a broken assertion.
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
