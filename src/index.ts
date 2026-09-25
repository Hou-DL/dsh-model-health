import { HealthStore } from "./host/store.ts";
import { SpeedTestRunner } from "./host/speed-test.ts";

export const name = "dsh-model-health";
export const inject = ["sessions", "llm"] as const;

export function apply(ctx: any) {
  const store = new HealthStore(ctx);
  const speed = new SpeedTestRunner(ctx);
  ctx.provide("modelHealthStore", store);

  store.init().catch((e: unknown) => {
    ctx.logger?.warn?.(`dsh-model-health init failed: ${String(e)}`);
  });

  ctx.on("session/event", (session: any, event: any) => {
    store.ingest({ ...event, sid: session?.id ?? "" });
  });

  // Browser client fetch: /api/dsh-model-health/health.json
  let unregisterRoute: (() => void) | null = null;
  let speedUnregister: (() => void) | null = null;
  ctx.inject(["webServer"], (wsCtx: any) => {
    try {
      const handler = (_req: any, res: any) => {
        try {
          const days = store.getDays();
          const body = JSON.stringify({
            version: 1 as const,
            ready: store.isReady(),
            days: [...days.entries()].map(([dayKey, models]) => ({
              dayKey,
              models: Object.fromEntries(models),
            })),
          });
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(body);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      };
      // speed-test: GET = state + known models, POST = start one probe
      const speedHandler = async (req: any, res: any) => {
        const json = (code: number, body: any) => {
          res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(body));
        };
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c: any) => (body += c));
          req.on("end", () => {
            try {
              const { provider, model } = JSON.parse(body || "{}");
              if (!provider || !model || provider === "undefined" || model === "undefined") {
                throw new Error(`invalid route: provider=${JSON.stringify(provider ?? null)}, model=${JSON.stringify(model ?? null)}`);
              }
              const ok = speed.start(String(provider), String(model));
              json(ok ? 200 : 409, { ok, test: speed.state() });
            } catch (e: any) {
              json(400, { ok: false, error: String(e?.message ?? e) });
            }
          });
          return;
        }
        // prefer the CURRENTLY available models from the llm registry; fall
        // back to history-derived routes when the service is unavailable
        const routes = (await speed.listRoutes().catch(() => [])) ?? [];
        json(200, { ok: true, test: speed.state(), models: routes.length > 0 ? routes : store.getModels() });
      };
      unregisterRoute = wsCtx.webServer.register({ kind: "exact", path: "/api/dsh-model-health/health.json", handler });
      speedUnregister = wsCtx.webServer.register({ kind: "exact", path: "/api/dsh-model-health/speed-test", handler: speedHandler });
      ctx.logger.info("dsh-model-health: registered /api/dsh-model-health/health.json + /speed-test");
      ctx.logger.info("dsh-model-health: registered /api/dsh-model-health/health.json");
    } catch (e) {
      ctx.logger?.warn?.(`dsh-model-health route register failed: ${String(e)}`);
    }
  });

  ctx.effect(
    () => () => {
      store.dispose();
      if (unregisterRoute) try { unregisterRoute(); } catch {}
      if (speedUnregister) try { speedUnregister(); } catch {}
    },
    "dsh-model-health.dispose",
  );

  ctx.logger.info("dsh-model-health host up");
}
