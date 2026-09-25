import { fileURLToPath } from "node:url";

/** Alias react to a hook-safe mock so components can be render-walked outside
 *  a React renderer (real React throws "Invalid hook call" in that case). */
export default {
  resolve: {
    alias: {
      "react/jsx-runtime": fileURLToPath(new URL("./test-mock/react-jsx-runtime.mjs", import.meta.url)),
      "react/jsx-dev-runtime": fileURLToPath(new URL("./test-mock/react-jsx-runtime.mjs", import.meta.url)),
      "react-dom": fileURLToPath(new URL("./test-mock/react.mjs", import.meta.url)),
      react: fileURLToPath(new URL("./test-mock/react.mjs", import.meta.url)),
    },
  },
  esbuild: { jsx: "automatic" },
};
