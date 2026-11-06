import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Workspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { CodexHarness } from "../codex-harness";
import { StressModel } from "../stress/model";

/** Synthetic model with a single interruptible call after the tool round. */
class RecoveryModel extends StressModel {
  constructor(private readonly ctx: DurableObjectState) {
    super();
  }

  override async doStream(options: LanguageModelV4CallOptions) {
    const kv = this.ctx.storage.kv;
    this.round = kv.get<number>("model-round") ?? 0;
    kv.put("model-calls", (kv.get<number>("model-calls") ?? 0) + 1);
    if (this.round === 1 && kv.get<boolean>("pause-model")) {
      kv.put("pause-model", false);
      kv.put("model-paused", true);
      // The test abruptly resets this incarnation while the completed tool
      // round remains in the task journal and kernel checkpoint.
      await new Promise<never>(() => {});
    }
    const result = await super.doStream(options);
    kv.put("model-round", this.round);
    return result;
  }
}

/** Host supplies only a model and Workspace; the harness installs the rest. */
export class TestCoder extends DurableObject {
  readonly workspace = new Workspace({ storage: this.ctx.storage });
  readonly codex = new CodexHarness({
    workspace: this.workspace,
    model: new RecoveryModel(this.ctx),
    compaction: false
  });
  readonly lifecycle = this.codex.install(Lifecycle.install(this));
}

declare global {
  namespace Cloudflare {
    interface Env {
      CODEX_HARNESS_TEST: DurableObjectNamespace<TestCoder>;
    }
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
