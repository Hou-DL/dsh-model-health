import { HealthStore } from "./host/store.ts";

export const name = "dsh-model-health";
export const inject = ["sessions"] as const;

export function apply(ctx: any) {
  const store = new HealthStore(ctx);
  ctx.provide("modelHealthStore", store);

  store.init().catch((e: unknown) => {
    ctx.logger?.warn?.(`dsh-model-health init failed: ${String(e)}`);
  });

  ctx.on("session/event", (session: any, event: any) => {
    store.ingest({ ...event, sid: session?.id ?? "" });
  });

  // Browser client fetch: /api/dsh-model-health/health.json
  let unregisterRoute: (() => void) | null = null;
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
      unregisterRoute = wsCtx.webServer.register({ kind: "exact", path: "/api/dsh-model-health/health.json", handler });
      ctx.logger.info("dsh-model-health: registered /api/dsh-model-health/health.json");
    } catch (e) {
      ctx.logger?.warn?.(`dsh-model-health route register failed: ${String(e)}`);
    }
  });

  ctx.effect(
    () => () => {
      store.dispose();
      if (unregisterRoute) try { unregisterRoute(); } catch {}
    },
    "dsh-model-health.dispose",
  );

  ctx.logger.info("dsh-model-health host up");
}
