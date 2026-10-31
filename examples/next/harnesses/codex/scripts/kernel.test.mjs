import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DirectKernelRuntime } from "../src/kernel-runtime.ts";
import { completeCodexModel } from "../src/language-model-v4.ts";

const module = await WebAssembly.compile(
  await readFile(
    new URL(
      "../wasm-kernel/target/wasm32-unknown-unknown/release/codex_worker_kernel.wasm",
      import.meta.url
    )
  )
);

async function start() {
  const runtime = new DirectKernelRuntime(module);
  const transition = await runtime.transition({
    type: "start_turn",
    thread_id: "thread-test",
    turn_id: "turn-test",
    model: "test-model"
  });
  return { runtime, transition };
}

function resolve(runtime, transition, frames) {
  return runtime.transition({
    type: "resolve_effect",
    checkpoint: transition.checkpoint,
    effect_id: transition.action.effect_id,
    result: { type: "model", frames }
  });
}

function model(parts, inspect = () => {}) {
  return {
    async doStream(options) {
      inspect(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          }
        })
      };
    }
  };
}

const finish = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" }
};
const toolCall = {
  type: "response.output_item.done",
  item: {
    type: "function_call",
    id: "fc_1",
    status: "completed",
    encrypted_content: null,
    call_id: "call-1",
    name: "workspace_write",
    arguments: '{"path":"/test.txt","content":"hello"}'
  }
};

test("0.165 developer input reaches the model and completes a tool round through Wasm", async () => {
  const { runtime, transition } = await start();
  assert.equal(transition.action.request.instructions, undefined);
  assert.equal(transition.action.request.input[0].role, "developer");
  const messages = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Write hello" }]
    }
  ];
  const transcript = {
    history: async () => messages,
    record: async (message) => {
      messages.push(message);
    }
  };
  const round = await completeCodexModel(
    model(
      [
        { type: "response-metadata", id: "resp-1" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "workspace_write",
          input: toolCall.item.arguments
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_calls" }
        }
      ],
      (options) => {
        assert.match(options.prompt[0].content, /You are Codex/);
        assert.equal(options.prompt[0].role, "system");
        assert.equal(options.prompt[1].content[0].text, "Write hello");
        assert.deepEqual(
          options.tools.map((tool) => tool.name),
          ["workspace_write", "workspace_read"]
        );
      }
    ),
    transition.action,
    "assistant-1",
    transcript
  );
  const called = await runtime.transition({
    type: "resolve_effect",
    checkpoint: transition.checkpoint,
    effect_id: transition.action.effect_id,
    result: round.result
  });
  assert.equal(called.action.type, "tool");
  assert.deepEqual(called.action.arguments, { $message: "assistant-1" });
  assert.deepEqual(messages[1].parts[0].input, {
    path: "/test.txt",
    content: "hello"
  });

  messages.push({
    id: "tool-1",
    role: "tool",
    parts: [
      {
        type: "tool-workspace_write",
        toolName: "workspace_write",
        toolCallId: "call-1",
        state: "output-available",
        output: { path: "/test.txt", bytes: 5 }
      }
    ]
  });
  const resumed = await runtime.transition({
    type: "resolve_effect",
    checkpoint: called.checkpoint,
    effect_id: called.action.effect_id,
    result: { type: "tool", output: { messageId: "tool-1" }, success: true }
  });
  const finalRound = await completeCodexModel(
    model(
      [{ type: "text-delta", id: "text-1", delta: "Wrote hello." }, finish],
      (options) => {
        assert.deepEqual(
          options.prompt.map((message) => message.role),
          ["system", "user", "assistant", "tool"]
        );
        assert.equal(options.prompt[3].content[0].toolCallId, "call-1");
      }
    ),
    resumed.action,
    "assistant-2",
    transcript
  );
  const completed = await runtime.transition({
    type: "resolve_effect",
    checkpoint: resumed.checkpoint,
    effect_id: resumed.action.effect_id,
    result: finalRound.result
  });
  assert.equal(completed.action.type, "completed");
  assert.equal(completed.action.output, "Wrote hello.");
});

test("a persisted pre-0.165 model action and v3 checkpoint resume after upgrade", async () => {
  // Captured from the previous compiled kernel, including its legacy request shape.
  const previous = JSON.parse(
    await readFile(
      new URL("./fixtures/pre-0.165-model-action.json", import.meta.url),
      "utf8"
    )
  );
  assert.equal(previous.checkpoint.version, 3);
  let recorded;
  const round = await completeCodexModel(
    model(
      [{ type: "text-delta", id: "text-1", delta: "Resumed." }, finish],
      (options) => {
        assert.equal(
          options.prompt[0].content,
          previous.action.request.instructions
        );
      }
    ),
    previous.action,
    "resumed-message",
    {
      history: async () => [],
      record: async (message) => {
        recorded = message;
      }
    }
  );
  const runtime = new DirectKernelRuntime(module);
  const completed = await runtime.transition({
    type: "resolve_effect",
    checkpoint: previous.checkpoint,
    effect_id: previous.action.effect_id,
    result: round.result
  });
  assert.equal(completed.action.output, "Resumed.");
  assert.equal(recorded.parts[0].text, "Resumed.");
  assert.equal(completed.events[0].seq, previous.checkpoint.next_event_seq);
});

test("response.created preserves the response ID", async () => {
  const { runtime, transition } = await start();
  const completed = await resolve(runtime, transition, [
    { type: "response.created", response: { id: "resp-created" } },
    { type: "response.output_text.delta", delta: "Done." },
    { type: "response.completed", response: { end_turn: true } }
  ]);
  assert.equal(completed.checkpoint.response_id, "resp-created");
  assert.equal(completed.events.at(-1).response_id, "resp-created");
});

for (const terminal of [
  { type: "response.completed", response: { id: "resp-1", end_turn: false } },
  {
    type: "response.incomplete",
    response: { id: "resp-1", incomplete_details: { reason: "interrupted" } }
  }
]) {
  test(`${terminal.type} with continuation requests the next model round`, async () => {
    const { runtime, transition } = await start();
    const resumed = await resolve(runtime, transition, [
      { type: "response.output_item.added", item: toolCall.item },
      terminal
    ]);
    assert.equal(resumed.action.type, "model");
    assert.equal(resumed.action.effect_id, "model:1");
    assert.equal(resumed.checkpoint.response_id, "resp-1");
    assert.equal(resumed.checkpoint.pending_calls.length, 0);
    assert.ok(!resumed.events.some((event) => event.type === "turn_completed"));
  });
}

test("interrupted responses execute completed calls before continuing, ignoring optional 0.165 metadata", async () => {
  const { runtime, transition } = await start();
  const called = await resolve(runtime, transition, [
    toolCall,
    {
      type: "response.incomplete",
      response: { id: "resp-1", incomplete_details: { reason: "interrupted" } }
    }
  ]);
  assert.equal(called.action.type, "tool");
  assert.equal(called.action.call_id, "call-1");
  const resumed = await runtime.transition({
    type: "resolve_effect",
    checkpoint: called.checkpoint,
    effect_id: called.action.effect_id,
    result: { type: "tool", output: "written", success: true }
  });
  assert.equal(resumed.action.type, "model");
  assert.equal(resumed.action.effect_id, "model:1");
});

for (const reason of ["content_filter", "max_output_tokens", "unknown"]) {
  test(`incomplete ${reason} fails without dispatching buffered tools`, async () => {
    const { runtime, transition } = await start();
    const failed = await resolve(runtime, transition, [
      toolCall,
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason } }
      }
    ]);
    assert.equal(failed.action.type, "failed");
    assert.ok(failed.action.message.includes(reason));
    assert.ok(!failed.events.some((event) => event.type === "tool_started"));
  });
}

for (const error of [
  { code: "model_not_found", message: "This model does not exist." },
  { code: "model_not_found", message: " " },
  { code: "flex_unavailable" }
]) {
  test(`provider error preserves ${JSON.stringify(error)}`, async () => {
    const { runtime, transition } = await start();
    const failed = await resolve(runtime, transition, [
      toolCall,
      { type: "error", error }
    ]);
    assert.equal(failed.action.type, "failed");
    assert.equal(
      failed.action.message,
      error.message?.trim() ? error.message : error.code
    );
    assert.ok(!failed.events.some((event) => event.type === "tool_started"));
  });
}

test("a truncated model response cannot dispatch a buffered tool", async () => {
  const { runtime, transition } = await start();
  const failed = await resolve(runtime, transition, [toolCall]);
  assert.equal(failed.action.type, "failed");
  assert.match(failed.action.message, /without a terminal event/);
});
