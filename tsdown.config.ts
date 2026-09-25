/** dsh-model-health build: ESM host (Node) + official client bundle
 *  (cjs wrapped in the `__ModuleLoader__` contract required by dsh-client-modules). */

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default [
  // Host-side plugin entry (Node ESM)
  {
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "es2024",
    outDir: "lib",
    clean: true,
    sourcemap: true,
    dts: false,
  },
  // Client-side bundle (single file served as /plugins/<id>/client.js)
  {
    name: "dsh-model-health/client",
    entry: { client: "src/client/index.ts" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    dts: false,
    clean: false,
    sourcemap: true,
    // react/jsx-runtime 必须外置：与 token-pulse 同构（真实加载器已验证可解析），
    // 内联它的 CJS 判断是 process.env 浏览器崩溃 bug 的温床
    external: [/@deepseek-ai\/dsh-client-/, "react", "react-dom", "react/jsx-runtime"],
    define: {
      __PLUGIN_VERSION__: JSON.stringify(pkg.version),
      // 浏览器环境没有 process 全局，内联的 react/jsx-runtime CJS 判断必须在这里静态替换
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner: 'window.__ModuleLoader__.load({ id: "dsh-model-health", factory: (require) => {',
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
];
