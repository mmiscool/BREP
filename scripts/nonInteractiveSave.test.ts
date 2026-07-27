import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeNonInteractiveSaveRequest,
  persistWithRollback,
} from "../src/UI/cad/nonInteractiveSave.js";

test("non-interactive save requires an explicit model path", () => {
  assert.throws(
    () => normalizeNonInteractiveSaveRequest({}),
    /requires modelPath/,
  );
});

test("non-interactive save validates complete storage scopes", () => {
  assert.throws(
    () => normalizeNonInteractiveSaveRequest({
      modelPath: "benchmarks/output",
      source: "github",
    }),
    /requires repoFull/,
  );
  assert.throws(
    () => normalizeNonInteractiveSaveRequest({
      modelPath: "benchmarks/output",
      source: "mounted",
    }),
    /requires repoFull/,
  );
  assert.throws(
    () => normalizeNonInteractiveSaveRequest({
      modelPath: "benchmarks/output",
      source: "github",
      repoFull: "owner/repo",
    }),
    /requires branch/,
  );
});

test("non-interactive save plans explicit overwrite behavior", () => {
  assert.deepEqual(
    normalizeNonInteractiveSaveRequest({
      modelPath: "benchmarks/output.3mf",
      source: "github",
      repoFull: "owner/repo",
      branch: "benchmark",
    }),
    {
      modelPath: "benchmarks/output.3mf",
      source: "github",
      repoFull: "owner/repo",
      branch: "benchmark",
      overwrite: false,
    },
  );
  assert.equal(
    normalizeNonInteractiveSaveRequest({
      modelPath: "benchmarks/output",
      overwrite: true,
    }).overwrite,
    true,
  );
});

test("aborted persistence restores the previous target", async () => {
  const controller = new AbortController();
  let stored = "previous";

  await assert.rejects(
    persistWithRollback({
      signal: controller.signal,
      write: async () => {
        stored = "replacement";
        controller.abort();
      },
      verify: async () => stored,
      rollback: async () => {
        stored = "previous";
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(stored, "previous");
});

test("failed persistence verification rolls back a new target", async () => {
  let stored: string | null = null;

  await assert.rejects(
    persistWithRollback({
      write: async () => {
        stored = "replacement";
      },
      verify: async () => {
        throw new Error("verification failed");
      },
      rollback: async () => {
        stored = null;
      },
    }),
    /verification failed/,
  );
  assert.equal(stored, null);
});

test("successful persistence returns verified evidence without rollback", async () => {
  let rollbackCount = 0;

  const evidence = await persistWithRollback({
    write: async () => undefined,
    verify: async () => ({ savedAt: "2026-07-24T12:00:00.000Z" }),
    rollback: async () => {
      rollbackCount += 1;
    },
  });

  assert.deepEqual(evidence, { savedAt: "2026-07-24T12:00:00.000Z" });
  assert.equal(rollbackCount, 0);
});
