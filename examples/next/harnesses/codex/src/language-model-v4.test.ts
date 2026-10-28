import { createAI } from "agents/models/ai-sdk";
import type { SessionMessage } from "agents/sessions";
import { describe, expect, it, vi } from "vitest";
import type { KernelAction } from "./kernel-types";
import {
  completeCodexModel,
  MAX_PROMPT_PART_BYTES,
  ModelRoundError,
  sessionMessagesToPrompt
} from "./language-model-v4";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";
const action: Extract<KernelAction, { type: "model" }> = {
  type: "model",
  effect_id: "model:0",
  request: {
    instructions: "Read and write durable files.",
    tools: [
      {
        type: "function",
        name: "workspace_read",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    ]
  }
};

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "response-1",
    choices: [{ index: 0, delta, finish_reason: finish }]
  };
}

/** Exercise the real createAI parser without making a network request. */
function provider(events: unknown[]) {
  const response = new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  );
  const run = vi
    .fn<
      (
        model: string,
        input: Record<string, unknown>,
        options: Record<string, unknown>
      ) => Promise<Response>
    >()
    .mockResolvedValue(response);
  const model = createAI({
    // Only run() is used by the provider; the other binding methods are not
    // needed to exercise the same transport as the example's env.AI.
    binding: { run } as unknown as Ai,
    id: "default"
  })(MODEL);
  return { model, run };
}

function transcript(messages: SessionMessage[] = []) {
  return {
    history: async () => messages,
    record: vi.fn(async (message: SessionMessage) => {
      messages.push(message);
    })
  };
}

describe("Codex with agents/models/ai-sdk", () => {
  it("preserves reasoning and every streamed tool call before the next round", async () => {
    const { model, run } = provider([
      chunk({ reasoning_content: "Inspect both files." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "read-a",
            type: "function",
            function: { name: "workspace_read", arguments: '{"path":' }
          }
        ]
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '"/a.txt"}' } }]
      }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: "read-b",
            type: "function",
            function: { name: "workspace_read", arguments: '{"path":' }
          }
        ]
      }),
      chunk({
        tool_calls: [{ index: 1, function: { arguments: '"/b.txt"}' } }]
      }),
      chunk({}, "tool_calls")
    ]);
    const messages: SessionMessage[] = [
      {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "Read both." }]
      }
    ];
    const history = transcript(messages);

    const round = await completeCodexModel(model, action, "assistant", history);

    expect(history.record).toHaveBeenCalledOnce();
    expect(messages.at(-1)?.parts).toEqual([
      { type: "reasoning", text: "Inspect both files." },
      ...["a", "b"].map((file) => ({
        type: "tool-workspace_read",
        toolCallId: `read-${file}`,
        toolName: "workspace_read",
        input: { path: `/${file}.txt` },
        state: "input-available"
      }))
    ]);
    expect(round.result).toMatchObject({
      type: "model",
      frames: [
        {
          type: "response.reasoning_summary_text.delta",
          delta: "Inspect both files."
        },
        ...["a", "b"].map((file) => ({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: `read-${file}`,
            name: "workspace_read",
            arguments: JSON.stringify({ $message: "assistant" })
          }
        })),
        { type: "response.completed", response: { end_turn: false } }
      ]
    });
    expect(run.mock.calls[0]?.[0]).toBe(MODEL);
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      gateway: { id: "default" }
    });
    const request = run.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      stream: true,
      tools: [{ type: "function", function: { name: "workspace_read" } }]
    });

    for (const file of ["a", "b"]) {
      messages.push({
        id: `output-${file}`,
        role: "tool",
        parts: [
          {
            type: "tool-workspace_read",
            toolName: "workspace_read",
            toolCallId: `read-${file}`,
            output: { path: `/${file}.txt`, content: file.toUpperCase() },
            state: "output-available"
          }
        ]
      });
    }
    const next = provider([
      chunk({ content: "Both files " }),
      chunk({ content: "are readable." }),
      chunk({}, "stop")
    ]);
    const answer = await completeCodexModel(
      next.model,
      action,
      "answer",
      history
    );
    expect(answer.result).toMatchObject({
      type: "model",
      frames: expect.arrayContaining([
        {
          type: "response.output_text.delta",
          delta: "Both files are readable."
        },
        {
          type: "response.completed",
          response: { id: "response-1", end_turn: true }
        }
      ])
    });
    const nextRequest = next.run.mock.calls[0]?.[1];
    expect(nextRequest).toMatchObject({
      messages: expect.arrayContaining(
        ["a", "b"].map((file) => ({
          role: "tool",
          name: "workspace_read",
          tool_call_id: `read-${file}`,
          content: JSON.stringify({
            path: `/${file}.txt`,
            content: file.toUpperCase()
          })
        }))
      )
    });
  });

  it("does not persist a failed model round before Tasks retries it", async () => {
    const { model } = provider([
      chunk({ content: "Partial answer" }),
      { error: { message: "Model capacity exceeded" } }
    ]);
    const history = transcript();
    await expect(
      completeCodexModel(model, action, "assistant", history)
    ).rejects.toBeInstanceOf(ModelRoundError);
    expect(history.record).not.toHaveBeenCalled();
  });

  it("reports an output-token limit as an incomplete response", async () => {
    const { model } = provider([
      chunk({ content: "Partial answer" }),
      chunk({}, "length")
    ]);
    const history = transcript();
    const round = await completeCodexModel(model, action, "assistant", history);
    expect(history.record).toHaveBeenCalledOnce();
    expect(round.result).toMatchObject({
      type: "model",
      frames: expect.arrayContaining([
        {
          type: "response.incomplete",
          response: {
            id: "response-1",
            error: { message: "LanguageModelV4 stopped with length" }
          }
        }
      ])
    });
  });

  it("keeps compaction summaries and bounds tool context without changing stored output", () => {
    const output = {
      path: "/large.txt",
      content: "x".repeat(MAX_PROMPT_PART_BYTES + 1)
    };
    const messages: SessionMessage[] = [
      {
        id: "summary",
        role: "system",
        parts: [{ type: "text", text: "Earlier work." }]
      },
      {
        id: "tool",
        role: "tool",
        parts: [
          {
            type: "tool-workspace_read",
            toolCallId: "read",
            output,
            state: "output-available"
          }
        ]
      }
    ];
    const prompt = sessionMessagesToPrompt("Instructions.", messages);
    expect(prompt[1]).toEqual({ role: "system", content: "Earlier work." });
    expect(JSON.stringify(prompt)).toContain(
      "use workspace_read with offset and max_bytes"
    );
    expect(JSON.stringify(prompt).length).toBeLessThan(1000);
    expect(messages[1]?.parts[0]?.output).toBe(output);
    expect(output.content.length).toBe(MAX_PROMPT_PART_BYTES + 1);
  });
});
