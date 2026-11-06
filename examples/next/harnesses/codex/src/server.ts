import { Workspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { createWorkersAI } from "workers-ai-provider";
import { CodexHarness } from "./codex-harness";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** Plain Durable Object composed with the Codex Lifecycle capability. */
export class Coder extends DurableObject<Env> {
  readonly workspace = new Workspace({ storage: this.ctx.storage });
  readonly codex = new CodexHarness({
    workspace: this.workspace,
    model: createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "default" }
    })(MODEL)
  });
  readonly webSockets = new WebSockets(
    this.codex.webSockets({
      // Abort the object after the reply is sent so the client can watch the
      // operation and Workspace survive a fresh incarnation.
      restart: () =>
        setTimeout(() => this.ctx.abort("restart requested from the demo"), 50)
    })
  );
  readonly lifecycle = this.codex.install(
    Lifecycle.install(this).use(this.webSockets)
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
