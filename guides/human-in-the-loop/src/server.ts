import { createOpenAI } from "@ai-sdk/openai";
import {
  createDataStreamResponse,
  type Message,
  streamText,
  type StreamTextOnFinishCallback,
} from "ai";
import { processToolCalls } from "./utils";
import { tools } from "./tools";
import { type Connection, routeAgentRequest } from "agents-sdk";
import { AIChatAgent } from "agents-sdk/ai-chat-agent";

type Env = {
  OPENAI_API_KEY: string;
};

export class HumanInTheLoop extends AIChatAgent<Env> {
  async onChatMessage(onFinish: StreamTextOnFinishCallback<any>) {
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        // Utility function to handle tools that require human confirmation
        // Checks for confirmation in last message and then runs associated tool
        const processedMessages = await processToolCalls(
          {
            messages: this.messages,
            dataStream,
            tools,
          },
          {
            // type-safe object for tools without an execute function
            getWeatherInformation: async ({ city }) => {
              const conditions = ["sunny", "cloudy", "rainy", "snowy"];
              return `The weather in ${city} is ${
                conditions[Math.floor(Math.random() * conditions.length)]
              }.`;
            },
          }
        );

        const openai = createOpenAI({
          apiKey: this.env.OPENAI_API_KEY,
        });

        const result = streamText({
          model: openai("gpt-4o"),
          messages: processedMessages,
          tools,
          onFinish,
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
