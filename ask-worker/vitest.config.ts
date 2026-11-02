import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // SQLite Durable Object + isolated storage 會留下 .sqlite-shm，關閉隔離
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            ALLOWED_ORIGIN: "https://tony197653.github.io",
            EXTRA_ALLOWED_ORIGIN: "http://127.0.0.1:4173",
            MOCK_AI: "1",
            // 預設關閉：正式行為。需測時鐘時由個別測試改走 DO ?now=
            ALLOW_TEST_NOW: "",
            WORKERS_AI_MODEL: "@cf/openai/gpt-oss-20b",
            WORKERS_AI_FALLBACK_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
            GROQ_MODEL: "openai/gpt-oss-120b",
            GEMINI_MODEL: "gemini-2.0-flash",
            OPENROUTER_MODEL: "google/gemma-2-9b-it:free",
            TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
            IP_SALT: "test-salt-for-unit-tests",
            GROQ_API_KEY: "",
            GEMINI_API_KEY: "",
            OPENROUTER_API_KEY: "",
          },
        },
      },
    },
  },
});
