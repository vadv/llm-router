// The mock catalog and its researched cards, shaped as the core writes them:
// keys spelled by the core's rule, one row per connection listing, and cards
// in both research schemas, so the Wiki can be designed against what it
// really receives. Values are plausible, not recorded.

import type {
  KnowledgeCard,
  KnowledgePricing,
  KnowledgeRating,
  LiveCatalogModel,
  ProviderModel,
  ResearchStatus,
} from "./api";

/// The core's rule, mirrored: the vendor path, a ":free" route, a "[1m]"
/// slice and the tokenator "cursor-" tag are cut, version dots become dashes.
function coreKey(upstreamId: string): string {
  const tail = upstreamId.split("/").pop() ?? upstreamId;
  return tail
    .split(":")[0]
    .split("[")[0]
    .replace(/^cursor-/, "")
    .replace(/^free-/, "")
    .toLowerCase()
    .replaceAll(".", "-");
}

/// Two spellings of one model; the catalog of the core reports one key.
const SPELLING: Record<string, string> = { "gpt5-1-mini": "gpt-5-1-mini" };

export function mockKey(upstreamId: string): string {
  return SPELLING[coreKey(upstreamId)] ?? coreKey(upstreamId);
}

const rating = (
  metric: string,
  value: number,
  source = "Artificial Analysis",
  as_of = "2026-10",
  note: string | null = null,
  url: string | null = null,
): KnowledgeRating => ({ metric, value, source, as_of, note, url });

const price = (input: number, output: number | null, cached: number | null = null, note: string | null = null): KnowledgePricing => ({
  currency: "USD",
  input_per_1m: input,
  cached_input_per_1m: cached,
  output_per_1m: output,
  note,
});

/// A card with every field of the current research schema.
function card(fields: Partial<KnowledgeCard> & Pick<KnowledgeCard, "vendor" | "description">): KnowledgeCard {
  return {
    canonical_name: null,
    release_date: null,
    use_cases: [],
    strengths: [],
    weaknesses: [],
    modality: null,
    context_window: null,
    pricing_hint: null,
    ratings: [],
    family_line: null,
    sources: ["https://example.com/model-card"],
    ...fields,
  };
}

type Listing = [provider: string, upstreamId: string, contextTokens?: number | null];
type MockModel = {
  key: string;
  listings: Listing[];
  /// Absent: nothing was researched for this model yet.
  card?: KnowledgeCard | null;
  /// Days since the card was collected; the core calls 30 days stale.
  ageDays?: number;
};

const AA = "https://artificialanalysis.ai/models";

export const MOCK_MODELS: MockModel[] = [
  {
    key: "glm-4-6",
    listings: [
      ["zai", "glm-4.6", 200_000],
      ["openrouter", "z-ai/glm-4.6", 200_000],
      ["openrouter", "z-ai/glm-4.6:batch", 200_000],
      ["alibaba", "glm-4.6", 128_000],
    ],
    card: card({
      canonical_name: "GLM-4.6",
      vendor: "Z.ai",
      release_date: "2025-09-30",
      description:
        "GLM-4.6 is Z.ai's open-weight coding and agent model and the successor of GLM-4.5. It is built for multi-step software work with tool calls and holds a 200K context. It trails frontier closed models on graduate-level science questions and takes no image input.",
      tags: ["coding", "agents", "reasoning", "open-weights"],
      use_cases: ["Repository-scale coding", "Agentic tool use", "Long-document analysis"],
      strengths: [
        "Reliable tool calling over long sessions",
        "200K context with 128K output",
        "Open weights under a permissive license",
      ],
      weaknesses: ["Text-only input", "Weaker on graduate-level science", "Spends many tokens on hard reasoning"],
      input_modalities: ["text"],
      output_modalities: ["text"],
      modality: "Text input; text output",
      context_window: 200_000,
      max_output_tokens: 128_000,
      parameters: "355B total, 32B active",
      license: "MIT",
      open_weights: true,
      knowledge_cutoff: "2025-07",
      reasoning: "optional",
      tool_calling: true,
      structured_output: true,
      speed: { output_tokens_per_second: 82.4, time_to_first_token_seconds: 0.9, source: "Artificial Analysis", as_of: "2026-10" },
      pricing: price(0.6, 2.2, 0.11, "Free, rate limited, on OpenRouter's free endpoint."),
      pricing_hint: "$0.60 per 1M input tokens, $0.11 per 1M cached input and $2.20 per 1M output tokens. Free, rate limited, on OpenRouter's free endpoint.",
      ratings: [
        rating("Intelligence Index", 71, "Artificial Analysis", "2026-10", null, `${AA}/glm-4-6`),
        rating("Intelligence Index v5.0.1 (Low effort)", 63),
        rating("GPQA Diamond", 79.8, "Artificial Analysis", "2026-10", null, `${AA}/glm-4-6`),
        rating("Coding Index", 38, "OpenRouter"),
        rating("SWE-bench Verified", 68, "OpenRouter"),
        rating("Terminal Bench 2.0 (%)", 40.1, "Z.ai GLM-4.6 blog", "2025-10", "Claude-Code harness"),
        rating("LiveCodeBench", 74.2, "Z.ai GLM-4.6 blog", "2025-10"),
      ],
      family_line: "Part of the GLM-4 family; GLM-4.6 refines GLM-4.5 through post-training on agentic tasks.",
      sources: ["https://z.ai/blog/glm-4.6", `${AA}/glm-4.6`, "https://openrouter.ai/z-ai/glm-4.6"],
    }),
  },
  {
    key: "glm-4-5-air",
    listings: [["zai", "glm-4.5-air", 128_000], ["openrouter", "z-ai/glm-4.5-air:free", 131_072]],
    // Collected by the first research schema: facts live in prose only.
    card: card({
      canonical_name: "GLM-4.5-Air",
      vendor: "Z.ai (Zhipu AI)",
      release_date: "2025-07-28",
      description:
        "GLM-4.5-Air is the smaller sibling of GLM-4.5, a 106B-parameter mixture-of-experts model with 12B active parameters. It keeps the coding and agent strengths of the family at about a third of the cost. It is text-only and lags the larger models on competition math.",
      use_cases: ["Everyday coding", "Chat assistants", "Tool calling on a budget"],
      strengths: ["Cheap per token", "Fast for its class", "Open weights under MIT"],
      weaknesses: ["Text-only input and output", "Weaker on competition math"],
      modality: "Text input and text output (text-only)",
      context_window: 128_000,
      pricing_hint:
        "On OpenRouter, GLM-4.5-Air is listed at $0.20 per 1M input tokens and $1.10 per 1M output tokens, with cache reads at $0.03 per 1M tokens.",
      ratings: [
        rating("Intelligence Index", 61),
        rating("GPQA Diamond", 70.2),
        rating("LiveCodeBench", 63.3, "Z.ai blog", "2025-08"),
      ],
      family_line: "GLM-4.5-Air is the lightweight variant of GLM-4.5 in the GLM-4 family.",
      sources: ["https://z.ai/blog/glm-4.5", "https://openrouter.ai/z-ai/glm-4.5-air"],
    }),
  },
  {
    key: "glm-4-5v",
    listings: [["zai", "glm-4.5v", 64_000]],
    card: card({
      canonical_name: "GLM-4.5V",
      vendor: "Z.ai (Zhipu AI)",
      release_date: "2025-08-11",
      description:
        "GLM-4.5V is Z.ai's open vision-language model for charts, documents, screenshots and short video. It grounds its answers in bounding boxes and keeps the tool-calling habits of the GLM-4.5 text models. Video understanding is limited to short clips.",
      tags: ["vision", "agents", "open-weights", "long-context"],
      use_cases: ["UI screenshot understanding", "Document and chart reasoning", "Video clip QA"],
      strengths: ["Strong chart and document grounding", "Open weights", "Tool calling"],
      weaknesses: ["Short video only", "Slower than text-only models"],
      input_modalities: ["text", "image", "video"],
      output_modalities: ["text"],
      modality: "Text, image, and video input; text output",
      context_window: 64_000,
      license: "MIT",
      open_weights: true,
      tool_calling: true,
      reasoning: "optional",
      pricing: price(0.6, 2.2, 0.11),
      pricing_hint: "$0.60 per 1M input tokens, $0.11 per 1M cached input and $2.20 per 1M output tokens.",
      ratings: [rating("MMMU-Pro", 68.4), rating("Intelligence Index", 58)],
      family_line: "The vision branch of the GLM-4.5 generation.",
      sources: ["https://z.ai/blog/glm-4.5v"],
    }),
  },
  {
    key: "deepseek-chat",
    listings: [
      ["deepseek", "deepseek-chat", 128_000],
      ["openrouter", "deepseek/deepseek-chat", 128_000],
      ["tokenator", "deepseek-chat", 128_000],
    ],
    card: card({
      canonical_name: "DeepSeek V3.2",
      vendor: "DeepSeek",
      release_date: "2025-12-01",
      description:
        "DeepSeek V3.2 is DeepSeek's general chat model, a sparse mixture of experts with 685B total and 37B active parameters. It introduced sparse attention, which cut the cost of long contexts. It takes text only and does not reason unless asked in the prompt.",
      use_cases: ["Chat and instruction following", "Summarization", "Cheap high-volume calls"],
      strengths: ["Very low price per token", "Fast for its size", "Strong instruction following"],
      weaknesses: ["Text-only input", "No built-in reasoning mode"],
      modality: "text",
      context_window: 128_000,
      pricing_hint:
        "Standard API pricing is $0.28 per 1M input tokens (cache hit $0.028) and $0.42 per 1M output tokens.",
      ratings: [rating("Intelligence Index", 66), rating("GPQA Diamond", 79.9), rating("LiveCodeBench", 70.1, "DeepSeek API Docs", "2025-12")],
      family_line: "The third generation of DeepSeek's V family; V3.2 followed V3.1 with cheaper long context.",
      sources: ["https://api-docs.deepseek.com/news/news251201", `${AA}/deepseek-v3-2`],
    }),
  },
  {
    key: "deepseek-reasoner",
    listings: [["deepseek", "deepseek-reasoner", 64_000]],
    card: card({
      canonical_name: "DeepSeek V3.2 Thinking",
      vendor: "DeepSeek",
      release_date: "2025-12-01",
      description:
        "DeepSeek V3.2 Thinking is the reasoning mode of V3.2: the model works through a problem before it answers and cannot skip that step. It is strong on competition math and code, at the price of slower and longer answers.",
      tags: ["reasoning", "math", "coding"],
      use_cases: ["Competition math", "Hard debugging", "Multi-step planning"],
      strengths: ["Top-tier math and reasoning", "Cheap for its class"],
      weaknesses: ["Always reasons, so answers are slower", "Long chains of thought cost output tokens"],
      input_modalities: ["text"],
      output_modalities: ["text"],
      modality: "Text input; text output",
      context_window: 128_000,
      max_output_tokens: 64_000,
      open_weights: true,
      license: "MIT",
      reasoning: "always",
      tool_calling: true,
      pricing: price(0.28, 0.42, 0.028),
      pricing_hint: "$0.28 per 1M input tokens, $0.028 per 1M cached input and $0.42 per 1M output tokens.",
      ratings: [rating("AIME 2025", 92.3, "DeepSeek API Docs", "2025-12"), rating("GPQA Diamond", 88.4), rating("Intelligence Index", 74)],
      family_line: "The reasoning configuration of DeepSeek V3.2.",
      sources: ["https://api-docs.deepseek.com/news/news251201"],
    }),
  },
  {
    key: "kimi-k2-5",
    listings: [
      ["openrouter", "moonshotai/kimi-k2.5:free", 262_144],
      ["tokenator", "cursor-kimi-k2.5", 262_144],
      ["kimi", "kimi-k2.5", 262_144],
    ],
    card: card({
      canonical_name: "Kimi K2.5",
      vendor: "Moonshot AI",
      release_date: "2026-02-16",
      description:
        "Kimi K2.5 is Moonshot AI's open-weight agent model, a trillion-parameter mixture of experts. It is tuned for long tool-using sessions, writing and creative work. Its claim-level hallucination rate is higher than the best closed models.",
      tags: ["agents", "coding", "writing", "open-weights", "long-context"],
      use_cases: ["Long agent runs", "Writing and roleplay", "Coding with tools"],
      strengths: ["Sustained tool use over long sessions", "Natural prose", "262K context"],
      weaknesses: ["Hallucinates more than frontier models", "Heavy to self-host"],
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      modality: "Text and image input; text output",
      context_window: 262_144,
      license: "Modified MIT",
      open_weights: true,
      tool_calling: true,
      reasoning: "optional",
      speed: { output_tokens_per_second: 61.2, time_to_first_token_seconds: 1.4, source: "Artificial Analysis", as_of: "2026-10" },
      pricing: price(0.6, 2.5, 0.15, "Free, rate limited, on OpenRouter."),
      pricing_hint: "$0.60 per 1M input tokens, $0.15 per 1M cached input and $2.50 per 1M output tokens. Free, rate limited, on OpenRouter.",
      ratings: [
        rating("Intelligence Index", 69),
        rating("SWE-bench Verified", 71.3, "OpenRouter"),
        rating("Terminal Bench 2.1 (%)", 44.2, "Moonshot AI blog", "2026-03"),
        rating("Design Arena Elo", 1130, "Design Arena", "2026-04"),
      ],
      family_line: "Third of the Kimi K2 open family, after K2 and K2 Thinking.",
      sources: ["https://www.kimi.ai/blog/kimi-k2-5", `${AA}/kimi-k2-5`],
    }),
  },
  {
    key: "kimi-latest",
    listings: [["openrouter", "~moonshotai/kimi-latest", 262_144]],
    card: card({
      // A rolling pointer: the researcher names the model it serves today.
      canonical_name: "Kimi K2.5",
      vendor: "Moonshot AI",
      release_date: "2026-02-16",
      description:
        "Kimi K2.5 is the model behind OpenRouter's rolling ~moonshotai/kimi-latest alias at the time of this research. The alias moves to each new Kimi release, so requests may change behavior without notice. Treat it as a convenience route, not a pinned model.",
      snapshot: "moonshotai/kimi-k2.5",
      use_cases: ["Always-latest Kimi access"],
      strengths: ["Follows new releases automatically"],
      weaknesses: ["The model behind it changes without notice"],
      modality: "Text and image input; text output",
      context_window: 262_144,
      pricing_hint: "OpenRouter lists $0.60 per 1M input tokens and $2.50 per 1M output tokens.",
      ratings: [rating("Intelligence Index", 69)],
      sources: ["https://openrouter.ai/moonshotai"],
    }),
  },
  {
    key: "qwen3-coder",
    listings: [
      ["openrouter", "qwen/qwen3-coder:free", 262_144],
      ["alibaba", "qwen3-coder", 262_144],
      ["opencode", "qwen3-coder", 262_144],
      ["tokenator", "cursor-qwen3-coder", 262_144],
    ],
    ageDays: 41,
    card: card({
      canonical_name: "Qwen3 Coder",
      vendor: "Alibaba Cloud (Qwen team / Tongyi Lab)",
      release_date: "2025-07-23",
      description:
        "Qwen3 Coder is Alibaba's open-weight coding model, a 480B-parameter mixture of experts with 35B active. It targets repository-scale edits with tools. It is text-only and weaker at general knowledge than similarly sized general models.",
      use_cases: ["Repository editing", "Frontend implementation", "Tool calling"],
      strengths: ["Strong on repository-scale edits", "Free route on OpenRouter", "Open weights"],
      weaknesses: ["Text-only input", "Weak general knowledge"],
      modality: "Text, image, and file input; text output",
      context_window: 262_144,
      pricing_hint: "$0.25 per million input tokens and $1.00 per million output tokens.",
      ratings: [rating("SWE-bench Verified", 61.2, "Qwen official blog", "2025-08"), rating("Intelligence Index", 60)],
      family_line: "The coding branch of the Qwen3 family.",
      sources: ["https://qwen.ai/blog/qwen3-coder", "https://openrouter.ai/qwen/qwen3-coder"],
    }),
  },
  { key: "qwen3-coder-30b", listings: [["llamacpp", "qwen3-coder-30b", 32_768]] },
  {
    key: "gpt-5-1",
    listings: [
      ["openai", "gpt-5.1", 400_000],
      ["openrouter", "openai/gpt-5.1", 400_000],
      ["openrouter", "openai/gpt-5.1:batch", 400_000],
    ],
    card: card({
      canonical_name: "GPT-5.1",
      vendor: "OpenAI",
      release_date: "2025-11-13",
      description:
        "GPT-5.1 is OpenAI's flagship model for reasoning over text and images with a reasoning effort the caller sets. It leads on coding agents and instruction following. It is among the most expensive models to run and slower than small models.",
      tags: ["coding", "reasoning", "vision", "agents", "long-context"],
      use_cases: ["Hard reasoning", "Coding agents", "Image understanding"],
      strengths: ["Leads coding agent benchmarks", "Configurable reasoning effort", "Image and text input"],
      weaknesses: ["Expensive", "Slow at high reasoning effort"],
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      modality: "Text and image input; text output",
      context_window: 400_000,
      max_output_tokens: 128_000,
      knowledge_cutoff: "2024-09",
      reasoning: "optional",
      tool_calling: true,
      structured_output: true,
      speed: { output_tokens_per_second: 74.1, time_to_first_token_seconds: 1.1, source: "Artificial Analysis", as_of: "2026-10" },
      pricing: price(1.25, 10, 0.125),
      pricing_hint: "$1.25 per 1M input tokens, $0.125 per 1M cached input and $10 per 1M output tokens.",
      ratings: [
        rating("Intelligence Index", 88, "Artificial Analysis", "2026-10", null, `${AA}/gpt-5-1`),
        rating("GPQA Diamond", 92.1),
        rating("SWE-bench Verified", 77.9, "OpenRouter"),
        rating("Terminal Bench 2.1 (%)", 62.4, "Terminal-Bench", "2026-06"),
        rating("τ²-Bench", 71.5, "OpenRouter"),
      ],
      family_line: "GPT-5.1 followed GPT-5 with adaptive reasoning effort.",
      sources: ["https://openai.com/index/gpt-5-1/", `${AA}/gpt-5-1`],
    }),
  },
  {
    key: "gpt-5-1-latest",
    listings: [["openrouter", "~openai/gpt-5.1-latest", 400_000]],
    card: card({
      canonical_name: "GPT-5.1",
      vendor: "OpenAI",
      release_date: "2025-11-13",
      description:
        "GPT-5.1 is the model behind OpenRouter's rolling ~openai/gpt-5.1-latest alias at the time of this research. The alias always serves the newest 5.1 snapshot, so behavior can shift between requests.",
      snapshot: "gpt-5.1-2025-11-13",
      use_cases: ["Always-latest 5.1 snapshot"],
      weaknesses: ["The snapshot behind it changes without notice"],
      modality: "Text and image input; text output",
      context_window: 400_000,
      pricing_hint: "$1.25 per 1M input tokens and $10 per 1M output tokens.",
      ratings: [rating("Intelligence Index", 88)],
      sources: ["https://openrouter.ai/openai"],
    }),
  },
  {
    key: "gpt-5-1-mini",
    listings: [["openrouter", "openai/gpt-5.1-mini", 400_000], ["tokenator", "cursor-gpt5.1-mini", 400_000]],
    card: card({
      canonical_name: "GPT-5.1 mini",
      vendor: "OpenAI",
      release_date: "2025-11-13",
      description:
        "GPT-5.1 mini is the small sibling of GPT-5.1, built for fast answers at a tenth of the price. It keeps image input and tool calling. It gives up accuracy on long multi-step problems.",
      use_cases: ["Fast assistants", "Classification and routing", "High-volume chat"],
      strengths: ["Cheap and fast", "Image input", "Tool calling"],
      weaknesses: ["Loses accuracy on long multi-step tasks"],
      modality: "Text and image input; text output",
      context_window: 400_000,
      pricing_hint: "OpenRouter lists $0.25 per 1M input tokens and $2.00 per 1M output tokens.",
      ratings: [rating("Intelligence Index", 74), rating("GPQA Diamond", 85.6)],
      family_line: "The small variant of the GPT-5.1 generation.",
      sources: ["https://openrouter.ai/openai/gpt-5.1-mini"],
    }),
  },
  {
    key: "claude-haiku-5-5",
    listings: [["opencode", "claude-haiku-5-5", 200_000], ["openrouter", "anthropic/claude-haiku-5.5", 200_000]],
    card: card({
      canonical_name: "Claude Haiku 5.5",
      vendor: "Anthropic",
      release_date: "2026-02-05",
      description:
        "Claude Haiku 5.5 is Anthropic's small fast model for everyday coding and support work. It is near-instant and a tenth of the price of the larger Claude models. It is not meant for long autonomous runs.",
      use_cases: ["Quick code edits", "Support and moderation", "Inline completions"],
      strengths: ["Near-instant responses", "Accurate on short tasks"],
      weaknesses: ["Not built for long agent runs"],
      modality: "Text and image input; text output",
      context_window: 200_000,
      pricing_hint: "Anthropic lists $1 per million input tokens and $5 per million output tokens.",
      ratings: [rating("SWE-bench Verified", 73.3, "Anthropic"), rating("Intelligence Index", 73)],
      family_line: "The Haiku tier of Claude 5.5, under Sonnet and Opus.",
      sources: ["https://www.anthropic.com/news/claude-haiku-5-5"],
    }),
  },
  {
    key: "claude-opus-5-5",
    listings: [["opencode", "claude-opus-5-5", 200_000], ["openrouter", "anthropic/claude-opus-5.5", 200_000]],
    card: card({
      canonical_name: "Claude Opus 5.5",
      vendor: "Anthropic",
      release_date: "2026-02-05",
      description:
        "Claude Opus 5.5 is Anthropic's model for long autonomous coding and computer use. It holds up over many hours of tool calls. It is slower and dearer than Sonnet and blocks some cybersecurity requests.",
      tags: ["coding", "agents", "vision"],
      use_cases: ["Long coding sessions", "Computer use", "Hard refactors"],
      strengths: ["Sustains long agent runs", "Computer-use ability", "Precise edits"],
      weaknesses: ["Slow", "Expensive", "Refuses some security tasks"],
      input_modalities: ["text", "image", "pdf"],
      output_modalities: ["text"],
      modality: "Text, image, and file input; text output",
      context_window: 200_000,
      max_output_tokens: 128_000,
      tool_calling: true,
      pricing: price(5, 25, 0.5),
      pricing_hint: "$5 per 1M input tokens, $0.50 per 1M cached input and $25 per 1M output tokens.",
      ratings: [rating("SWE-bench Verified", 80.9, "Anthropic"), rating("Terminal Bench 4.0 (%)", 78.2, "Anthropic", "2026-05"), rating("OSWorld-Verified", 71.4, "Anthropic")],
      family_line: "The largest of the Claude 5.5 models, above Sonnet and Haiku.",
      sources: ["https://www.anthropic.com/news/claude-opus-5-5"],
    }),
  },
  {
    key: "gemini-3-1-pro",
    listings: [["opencode", "gemini-3.1-pro", 1_048_576], ["openrouter", "google/gemini-3.1-pro-preview", 1_048_576]],
    card: card({
      canonical_name: "Gemini 3.1 Pro",
      vendor: "Google DeepMind",
      release_date: "2026-02-19",
      description:
        "Gemini 3.1 Pro is Google's multimodal model with a one-million-token context. It reads text, images, audio and video and answers with text. Its table-stakes latency is higher than that of the Flash models.",
      tags: ["vision", "audio", "long-context", "multilingual", "reasoning"],
      use_cases: ["Video and document understanding", "Very long context", "Multilingual work"],
      strengths: ["1M context", "Native video and audio input", "Wide language coverage"],
      weaknesses: ["Slow time to first token", "Dear above 200K context"],
      input_modalities: ["text", "image", "video", "audio", "pdf"],
      output_modalities: ["text"],
      modality: "Text, image, audio, file, and video input; text output",
      context_window: 1_048_576,
      tool_calling: true,
      structured_output: true,
      speed: { output_tokens_per_second: 71.3, time_to_first_token_seconds: 2.1, source: "Artificial Analysis", as_of: "2026-10" },
      pricing: price(1.25, 10, 0.125, "$2.50 in and $15 out above 200K context."),
      pricing_hint: "$1.25 per 1M input tokens and $10 per 1M output tokens up to 200K context; $2.50/$15 above.",
      ratings: [rating("Intelligence Index", 84), rating("GPQA Diamond", 91.6), rating("MMMU-Pro", 81.3), rating("AIME 2025", 95.7, "Google blog", "2026-03")],
      family_line: "Gemini 3.1 Pro followed Gemini 3 Pro Preview.",
      sources: ["https://blog.google/products/gemini/gemini-3-1-pro", `${AA}/gemini-3-1-pro`],
    }),
  },
  {
    key: "gemini-3-1-flash-image",
    listings: [["openrouter", "google/gemini-3.1-flash-image", 32_768]],
    card: card({
      canonical_name: "Gemini 3.1 Flash Image",
      vendor: "Google DeepMind",
      release_date: "2026-01-20",
      description:
        "Gemini 3.1 Flash Image is Google's image generation and editing model. It draws from a text prompt and edits an input image while keeping faces consistent. It does not answer general questions.",
      tags: ["image-generation", "vision"],
      use_cases: ["Text-to-image", "Image editing", "Storyboarding"],
      strengths: ["Consistent characters across edits", "Fast"],
      weaknesses: ["Text in images is unreliable", "No general chat"],
      input_modalities: ["text", "image"],
      output_modalities: ["image"],
      modality: "Text and image input; image output",
      context_window: 32_768,
      pricing: price(0.3, 2.4, null, "$30 per 1M image output tokens; about $0.039 per image."),
      pricing_hint: "Google prices output at $30.00 per 1M tokens (about $0.039 per image), while OpenRouter lists $0.30/M input tokens and $2.40/M output tokens.",
      ratings: [rating("Design Arena Elo", 1184, "Design Arena", "2026-03")],
      family_line: "The image model of the Gemini 3.1 Flash line.",
      sources: ["https://ai.google.dev/gemini-api/docs/image-generation"],
    }),
  },
  {
    key: "text-embedding-3-small",
    listings: [["openai", "text-embedding-3-small", 8_191]],
    card: card({
      canonical_name: "text-embedding-3-small",
      vendor: "OpenAI",
      release_date: "2024-01-25",
      description:
        "text-embedding-3-small is OpenAI's compact embedding model for search, clustering and retrieval. It turns text into 1,536-dimension vectors and cannot chat. It is the cheapest of OpenAI's embeddings.",
      tags: ["embedding"],
      use_cases: ["Semantic search", "Retrieval for chat", "Clustering"],
      strengths: ["Cheap", "Fast"],
      input_modalities: ["text"],
      output_modalities: [],
      modality: "Text input; vector output",
      context_window: 8_191,
      pricing: price(0.02, null),
      pricing_hint: "$0.02 per 1M input tokens; embeddings have no output price.",
      sources: ["https://platform.openai.com/docs/models/text-embedding-3-small"],
    }),
  },
  { key: "minimax-m2-7", listings: [["opencode", "minimax-m2.7", 200_000]] },
  { key: "llama-3-3-70b", listings: [["tokenator", "cursor-llama-3.3-70b", 128_000]] },
];

/// One row per listing, as the core's catalog reports them.
export function catalogRows(observedAt: (provider: string) => number): LiveCatalogModel[] {
  return MOCK_MODELS.flatMap(({ key, listings }) =>
    listings.map(([provider_id, upstream_id, context_tokens]) => ({
      provider_id,
      upstream_id,
      context_tokens: context_tokens ?? null,
      knowledge_key: key,
      observed_at_unix: observedAt(provider_id),
    })),
  );
}

export function modelsByProvider(observedAt: (provider: string) => number): Record<string, ProviderModel[]> {
  const byProvider: Record<string, ProviderModel[]> = {};
  for (const { listings } of MOCK_MODELS)
    for (const [provider_id, upstream_id, context_tokens] of listings)
      (byProvider[provider_id] ??= []).push({ upstream_id, context_tokens: context_tokens ?? null, observed_at_unix: observedAt(provider_id) });
  return byProvider;
}

const MAX_AGE_DAYS = 30;
const DAY = 86_400;

// Cards collected while the mock runs, by key.
const collected = new Map<string, KnowledgeCard>();
const collectedAt = new Map<string, number>();

export function mockCard(key: string): KnowledgeCard | null {
  const model = MOCK_MODELS.find((m) => m.key === key);
  return collected.get(key) ?? model?.card ?? null;
}

export function mockCollectedAt(key: string, now: number): number | null {
  if (!mockCard(key)) return null;
  const model = MOCK_MODELS.find((m) => m.key === key);
  return collectedAt.get(key) ?? now - (model?.ageDays ?? 4) * DAY;
}

export function maxAgeDays() {
  return MAX_AGE_DAYS;
}

/// What a research call writes for a model the mock has no card for.
export function researchMockCard(key: string, upstreamId: string, now: number): KnowledgeCard {
  const found = card({
    canonical_name: key,
    vendor: "Independent",
    description: `${key} is the model served as ${upstreamId} on this connection. This card is mock research: it shows what a fresh card looks like, and none of its numbers is a measurement.`,
    use_cases: ["General chat"],
    strengths: ["Documented sources"],
    weaknesses: ["Mock content, not a measurement"],
    modality: "Text input; text output",
    context_window: 128_000,
    pricing: price(1, 4),
    pricing_hint: "$1 per 1M input tokens and $4 per 1M output tokens.",
    ratings: [rating("Intelligence Index", 55, "Artificial Analysis (design data)", "2026-06", "Plausible mock value")],
    family_line: `Mock card for ${key}.`,
    sources: ["https://example.com/model-card"],
  });
  collected.set(key, found);
  collectedAt.set(key, now);
  return found;
}

// The mock's "research every card" job. It walks a queue and advances on
// every status read, so the progress bar has something to show.
// Written out, not imported: api.ts imports the mock, so a value import
// back from it would be a cycle.
const idle = (): ResearchStatus => ({
  running: false,
  total: 0,
  done: 0,
  updated: 0,
  failed: 0,
  skipped: 0,
  current: [],
  errors: [],
  cancel_requested: false,
  started_at_unix: null,
  finished_at_unix: null,
});
let research: ResearchStatus = idle();
let queue: string[] = [];

// "#/wiki?job=running" opens with a job three fifths done, so a screenshot
// can show the progress bar without starting one.
export function mockJobInProgress(): ResearchStatus {
  const total = MOCK_MODELS.length;
  const done = Math.floor((total * 3) / 5);
  queue = MOCK_MODELS.map((model) => model.key);
  research = {
    ...idle(),
    running: true,
    total,
    done,
    updated: done - 1,
    failed: 1,
    current: queue.slice(done, done + 2),
    errors: [{ key: queue[3], error: "research: upstream: request timed out" }],
    started_at_unix: Math.floor(Date.now() / 1000) - 1500,
  };
  return { ...research };
}

export function startMockResearch(force: boolean, now: number): ResearchStatus {
  queue = MOCK_MODELS.filter((m) => force || !m.card).map((m) => m.key);
  research = {
    ...idle(),
    running: true,
    total: queue.length,
    started_at_unix: now,
    current: queue.slice(0, 2),
  };
  return { ...research };
}

export function cancelMockResearch(): ResearchStatus {
  research = { ...research, cancel_requested: true };
  return { ...research };
}

export function mockResearch(now: number): ResearchStatus {
  if (!research.running) return { ...research };
  // Two cards finish between two reads; a cancel stops after the next one.
  const stopping = research.cancel_requested;
  for (const key of queue.slice(research.done, research.done + (stopping ? 1 : 2))) {
    const model = MOCK_MODELS.find((m) => m.key === key);
    // Every twelfth card of a full run fails, so the failure list has a shape.
    if (!stopping && research.total === MOCK_MODELS.length && (research.done + 5) % 12 === 0) {
      research = {
        ...research,
        failed: research.failed + 1,
        errors: [...research.errors.slice(-24), { key, error: "research: upstream: request timed out" }],
      };
    } else {
      if (!mockCard(key) && model) researchMockCard(key, model.listings[0][1], now);
      else collectedAt.set(key, now);
      research = { ...research, updated: research.updated + 1 };
    }
    research = { ...research, done: research.done + 1 };
  }
  if (research.done >= research.total || stopping)
    research = { ...research, running: false, current: [], finished_at_unix: now };
  else research = { ...research, current: queue.slice(research.done, research.done + 2) };
  return { ...research };
}
