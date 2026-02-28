import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/agent/index.ts",
    "src/claude/index.ts",
    "src/langgraph/index.ts",
    "src/cli/index.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  external: [
    // LangChain — optional deps, not bundled
    "@langchain/core",
    "@langchain/core/tools",
    "@langchain/core/messages",
    "@langchain/langgraph",
    "@langchain/langgraph/prebuilt",
    "@langchain/anthropic",
    "@langchain/mcp-adapters",
    "langchain",
    "langchain/chat_models/universal",
  ],
});
