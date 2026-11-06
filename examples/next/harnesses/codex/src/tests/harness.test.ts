/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestCoder } from "./worker";

function object(): DurableObjectStub<TestCoder> {
  return env.CODEX_HARNESS_TEST.getByName(crypto.randomUUID());
}

async function completed(stub: DurableObjectStub<TestCoder>, id: string) {
  await runDurableObjectAlarm(stub);
  await expect
    .poll(() =>
      runInDurableObject(stub, (instance) => instance.codex.snapshot(id))
    )
    .toMatchObject({ status: "completed" });
}

describe("Codex harness-owned capabilities", () => {
  it("runs tools and retains the transcript, file, events, and deduplication after eviction", async () => {
    const stub = object();
    const input = { operationId: "tools", prompt: "Write and read a file" };
    expect(
      await runInDurableObject(stub, (instance) => instance.codex.submit(input))
    ).toMatchObject({ accepted: true });
    await completed(stub, input.operationId);

    const before = await runInDurableObject(stub, async (instance) => ({
      operation: await instance.codex.snapshot(input.operationId),
      events: await instance.codex.events(input.operationId),
      file: await instance.codex.readFile("/stress/file-0-0.txt")
    }));
    expect(before.operation?.output).toContain("final answer");
    expect(before.file.found).toBe(true);
    expect(before.file.content).toContain("/stress/file-0-0.txt");
    expect(before.events.length).toBeGreaterThan(0);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      expect(await instance.codex.snapshot(input.operationId)).toEqual(
        before.operation
      );
      expect(await instance.codex.events(input.operationId)).toEqual(
        before.events
      );
      expect(await instance.codex.readFile("/stress/file-0-0.txt")).toEqual(
        before.file
      );
      expect(await instance.codex.submit(input)).toMatchObject({
        accepted: false
      });
      expect(state.storage.kv.get("model-calls")).toBe(2);
      const roles = state.storage.sql
        .exec<{ role: string }>("SELECT role FROM cf_agents_session_messages")
        .toArray()
        .map((row) => row.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(roles).toContain("tool");
    });
  });

  it("recovers a queued operation using the original Tasks job identity", async () => {
    const stub = object();
    await runInDurableObject(stub, async (instance, state) => {
      await instance.codex.submit({
        operationId: "queued",
        prompt: "Queued turn"
      });
      // Keep the queued operation observable until this incarnation is gone.
      const future = Date.now() + 60_000;
      state.storage.sql.exec(
        "UPDATE cf_agents_task_runs SET next_at = ?",
        future
      );
      state.storage.sql.exec("UPDATE cf_agents_jobs SET time = ?", future);
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.lifecycle.start();
      state.storage.sql.exec("UPDATE cf_agents_task_runs SET next_at = 0");
      state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0");
      await instance.lifecycle.rearmAlarm();
    });
    await completed(stub, "queued");
  });

  it("resumes an interrupted model call after a completed tool round", async () => {
    let stub = object();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.kv.put("pause-model", true);
      await instance.codex.submit({
        operationId: "interrupted",
        prompt: "Recover this turn"
      });
    });
    // Keep the alarm in flight while the model call is paused. An abrupt
    // reset may reject it, which is expected for the interrupted invocation.
    const alarm = runDurableObjectAlarm(stub).catch(() => false);
    await expect
      .poll(() =>
        runInDurableObject(stub, (_instance, state) =>
          state.storage.kv.get("model-paused")
        )
      )
      .toBe(true);
    await abortAllDurableObjects();
    await alarm;
    stub = env.CODEX_HARNESS_TEST.get(stub.id);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.lifecycle.start();
      // Advance the lost attempt's recovery deadline without waiting for
      // its real timeout. Keep its checkpoint and completed steps intact.
      state.storage.sql.exec("UPDATE cf_agents_task_runs SET next_at = 0");
      state.storage.sql.exec(
        "UPDATE cf_agents_task_steps SET next_at = 0 WHERE state = 'running'"
      );
      state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0");
      await instance.lifecycle.rearmAlarm();
    });
    await completed(stub, "interrupted");
    await runInDurableObject(stub, async (instance, state) => {
      expect(state.storage.kv.get("model-calls")).toBe(3);
      expect(
        (await instance.codex.readFile("/stress/file-0-0.txt")).found
      ).toBe(true);
      expect(
        state.storage.sql
          .exec<{ attempt: number }>(
            "SELECT attempt FROM cf_agents_task_runs WHERE run_id = 'codex:interrupted'"
          )
          .one().attempt
      ).toBe(2);
    });
  });
});
