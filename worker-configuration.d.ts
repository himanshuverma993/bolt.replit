interface Env {
  DEFAULT_NUM_CTX: Settings;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GROQ_API_KEY: string;
  HuggingFace_API_KEY: string;
  OPEN_ROUTER_API_KEY: string;
  OLLAMA_API_BASE_URL: string;
  OPENAI_LIKE_API_KEY: string;
  OPENAI_LIKE_API_BASE_URL: string;
  TOGETHER_API_KEY: string;
  TOGETHER_API_BASE_URL: string;
  DEEPSEEK_API_KEY: string;
  LMSTUDIO_API_BASE_URL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  MISTRAL_API_KEY: string;
  XAI_API_KEY: string;
  PERPLEXITY_API_KEY: string;
  ASSETS: Fetcher;
  AI: Ai;
  /** Preferred secret for sealing GitHub/MCP credentials (see HARDENING_REPORT.md). */
  APP_ENCRYPTION_SECRET?: string;
  /** Fallback secret names kept for backwards compatibility with previous deployments. */
  GITHUB_COOKIE_SECRET?: string;
  MCP_COOKIE_SECRET?: string;
}
