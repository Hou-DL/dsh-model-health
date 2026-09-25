import * as React from "react";
import { SettingsSection } from "./SettingsSection.js";
import { zh, en } from "./locales.js";

const NS = "dsh-model-health";

export const inject = ["locale", "slots"] as const;

// Replace the default gear with an activity/pulse icon for this settings entry
const NAV_CSS = `
[data-dsh-model-health-nav] > svg:first-child { display: none; }
[data-dsh-model-health-nav]::before {
  content: ''; flex: none; width: 16px; height: 16px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 12h-4l-3 9L9 3l-3 9H2'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 12h-4l-3 9L9 3l-3 9H2'/%3E%3C/svg%3E") center / contain no-repeat;
}
`;

function injectNavCss() {
  if (typeof document === "undefined") return;
  const id = "dsh-model-health-nav-css";
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = NAV_CSS;
  document.head.appendChild(el);
}

let t_global: (k: string, p?: any) => string = (k) => k;

function markNavRow() {
  if (typeof document === "undefined") return;
  const label = t_global("nav");
  const labels = [label, "模型健康度", "Model Health"].filter(Boolean);
  for (const l of labels) {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(l));
    if (btn) btn.setAttribute("data-dsh-model-health-nav", "");
  }
}

export function apply(ctx: any) {
  injectNavCss();
  // Expose the EN dictionary for the in-page language switch
  (globalThis as any).__mh_en = en;
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    "dsh-model-health: dictionaries",
  );
  const t = ctx.locale.bind(NS);
  t_global = t;

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "modelHealth",
        order: 56,
        label: () => t("nav"),
        locale: NS,
      },
      (props: any) => {
        setTimeout(markNavRow, 50);
        return React.createElement(SettingsSection, { t, ctx, ...props });
      },
    ),
  );
  if (typeof document !== "undefined") {
    const mo = new MutationObserver(() => markNavRow());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 30000);
  }
}
