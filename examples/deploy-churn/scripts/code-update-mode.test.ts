import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentOptions } from "./code-update-mode";

test("recovery runs explicitly force code-update resets by default", () => {
  assert.deepEqual(deploymentOptions(), {
    mode: "immediate",
    args: [
      "run",
      "deploy",
      "--",
      "--durable-objects-code-update-mode",
      "immediate"
    ]
  });
});

test("deferred runs pass both the mode and its drain window to deploy", () => {
  assert.deepEqual(deploymentOptions("deferred"), {
    mode: "deferred",
    args: [
      "run",
      "deploy",
      "--",
      "--durable-objects-code-update-mode",
      "deferred",
      "300s"
    ]
  });
});

test("rejects unknown modes before a deployment starts", () => {
  assert.throws(() => deploymentOptions("deferrred"), /immediate or deferred/);
});
