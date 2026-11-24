// Self-check of the card normalizers. Run: node scripts/check-model-facts.mjs
// The samples are shapes the live researcher really writes; the assertions
// pin what a person then sees in the Wiki.
import assert from "node:assert/strict";
import {
  benchmarkOf,
  canonicalVendor,
  indexEras,
  modelSpecs,
  otherScoresOf,
  parsePricing,
  priceAmount,
  priceText,
  scoresOf,
  sourceHost,
  sourceKind,
  splitDescription,
  licenseLabel,
} from "../src/model-facts.ts";

let checks = 0;
function test(name, body) {
  body();
  checks += 1;
  console.log(`ok ${name}`);
}
const rating = (metric, value, source = "Artificial Analysis", as_of = "2026-10", note = null) => ({
  metric,
  value,
  source,
  as_of,
  note,
});

test("one label per vendor", () => {
  assert.equal(canonicalVendor("Alibaba Cloud (Qwen team / Tongyi Lab)"), "Alibaba");
  assert.equal(canonicalVendor("Alibaba Cloud"), "Alibaba");
  assert.equal(canonicalVendor("Moonshot AI 月之暗面 (Kimi)"), "Moonshot AI");
  assert.equal(canonicalVendor("Z.ai (Zhipu AI)"), "Z.ai");
  assert.equal(canonicalVendor("Google DeepMind"), "Google");
  assert.equal(canonicalVendor("xAI (SpaceXAI)"), "xAI");
  assert.equal(canonicalVendor("Thinking Machines Lab, Inc."), "Thinking Machines Lab");
  assert.equal(canonicalVendor("Fireworks AI / Fireworks Research"), "Fireworks AI");
  assert.equal(canonicalVendor("AionLabs"), "Aion Labs");
  assert.equal(canonicalVendor("Anthropic"), "Anthropic");
  assert.equal(canonicalVendor(null), null);
  assert.equal(canonicalVendor(""), null);
});

test("structured pricing wins over the sentence", () => {
  const card = {
    ratings: [],
    pricing: {
      currency: "USD",
      input_per_1m: 1.131,
      cached_input_per_1m: 0.283,
      output_per_1m: 3.957,
      note: "Alibaba Cloud list price",
    },
    pricing_hint: "OpenRouter lists $9 per 1M input tokens and $19 per 1M output tokens.",
  };
  assert.deepEqual(parsePricing(card), {
    currency: "USD",
    input: 1.131,
    cachedInput: 0.283,
    output: 3.957,
    free: false,
    note: "Alibaba Cloud list price",
  });
});

test("list prices read out of a sentence", () => {
  const read = (pricing_hint) => parsePricing({ ratings: [], pricing_hint });
  // Direction after the price.
  assert.deepEqual(pick(read("$8 per 1M input tokens and $40 per 1M output tokens.")), [8, 40, null]);
  // Direction before the price.
  assert.deepEqual(pick(read("Input is $0.30 per million tokens and output is $0.90 per million tokens.")), [0.3, 0.9, null]);
  // A cached price between the two must not steal the output.
  assert.deepEqual(
    pick(read("On OpenRouter, Aion-2.0 is listed at $0.80 per 1M input tokens and $1.60 per 1M output tokens, with cache reads at $0.20 per 1M tokens.")),
    [0.8, 1.6, 0.2],
  );
  assert.deepEqual(
    pick(read("OpenRouter lists $10/M input tokens, $50/M output tokens, $0.25/M cache reads, and $12.50/M cache writes.")),
    [10, 50, 0.25],
  );
  assert.deepEqual(
    pick(read("$2 per million cache-miss input tokens, $0.20 per million cached input tokens, and $10 per million output tokens.")),
    [2, 10, 0.2],
  );
  // "X/Y" repeats the pair for a second tier: the first pair is the list price.
  assert.deepEqual(pick(read("List price is $8 per 1M input tokens and $40 per 1M output tokens, with optional fast mode at $16/$80 per 1M tokens.")), [8, 40, null]);
  // A range is not a list price.
  assert.equal(read("Listings around $0.048-$0.144 per 1M tokens on the batch endpoint."), null);
  // Free is a real zero on both sides.
  assert.equal(read("$0.00 input/output for a limited time.").free, true);
  // Other units are read as written and scaled to one million.
  assert.deepEqual(pick(read("$0.0008 per 1K input tokens and $0.002 per 1K output tokens.")), [0.8, 2, null]);
  // CNY stays CNY.
  assert.equal(read("Baidu Qianfan charges RMB 1 per 1M input tokens and RMB 4 per 1M output tokens.").currency, "CNY");
  // No price, no guess.
  assert.equal(read("Billing is pay-as-you-go based on the actual routed model's token usage."), null);
  assert.equal(read("The hosted endpoint is free for prototyping at up to 40 requests per minute."), null);
  assert.equal(parsePricing({ ratings: [] }), null);
  function pick(pricing) {
    return pricing && [pricing.input, pricing.output, pricing.cachedInput];
  }
});

test("price text keeps the digits the researcher wrote", () => {
  assert.equal(priceAmount(8), "8");
  assert.equal(priceAmount(1.13), "1.13");
  assert.equal(priceAmount(1.131), "1.131");
  assert.equal(priceAmount(0.007), "0.007");
  assert.equal(priceAmount(0.00038), "0.00038");
  assert.equal(priceAmount(40), "40");
  assert.equal(priceText(1.5), "$1.5");
  assert.equal(priceText(1.5, "CNY"), "CNY 1.5");
  assert.equal(priceText(null), null);
  assert.equal(priceText(NaN), null);
});

test("specs fall back to the prose of older cards", () => {
  const modalities = (modality) => {
    const { input, output } = modelSpecs({ ratings: [], modality });
    return [input.join("+"), output.join("+")];
  };
  assert.deepEqual(modalities("Text input and text output (text-only)"), ["text", "text"]);
  assert.deepEqual(modalities("text-to-text"), ["text", "text"]);
  assert.deepEqual(modalities("Text, image, and file input; text output"), ["text+image+pdf", "text"]);
  assert.deepEqual(modalities("Multimodal input (text, image, video) and text output"), ["text+image+video", "text"]);
  assert.deepEqual(modalities("Video classification (video input, text output)"), ["video", "text"]);
  assert.deepEqual(modalities("Speech input, text output"), ["audio", "text"]);
  assert.deepEqual(modalities("text-to-image"), ["text", "image"]);
  assert.deepEqual(modalities("Image and text input; text output"), ["text+image", "text"]);
  assert.deepEqual(modalities("text"), ["text", "text"]);
  assert.deepEqual(modalities(null), ["text", "text"]);
  // Structured fields win.
  const structured = modelSpecs({
    ratings: [],
    modality: "text",
    input_modalities: ["text", "image", "pdf"],
    output_modalities: ["text"],
    context_window: 262144,
    max_output_tokens: 32768,
    license: "Apache 2.0",
    open_weights: true,
    reasoning: "optional",
    tool_calling: true,
    knowledge_cutoff: "2026-01",
    parameters: "397B total, 17B active",
  });
  assert.deepEqual([structured.input, structured.output], [["text", "image", "pdf"], ["text"]]);
  assert.equal(structured.maxOutput, 32768);
  assert.equal(structured.license, "Apache 2.0");
  assert.equal(structured.openWeights, true);
  assert.equal(structured.reasoning, "optional");
  assert.equal(structured.toolCalling, true);
  assert.equal(structured.knowledgeCutoff, "2026-01");
  assert.equal(structured.parameters, "397B total, 17B active");
  // Max output and license read out of the prose.
  const prose = modelSpecs({
    ratings: [],
    description:
      "Kimi K3.1 Pro is a post-trained successor with a 1,048,576-token context window and 128K-token maximum output. It is released under Apache 2.0 with weights on Hugging Face.",
  });
  assert.equal(prose.maxOutput, 128000);
  assert.equal(prose.license, "Apache 2.0");
  assert.equal(prose.openWeights, true);
  assert.equal(prose.context, null);
  // Nothing stated is nothing shown, never a zero.
  const empty = modelSpecs({ ratings: [], description: "A model with a 1M context window." });
  assert.equal(empty.maxOutput, null);
  assert.equal(empty.license, null);
  assert.equal(empty.openWeights, null);
  assert.equal(empty.reasoning, null);
  // A cutoff that is not a month is dropped.
  assert.equal(modelSpecs({ ratings: [], knowledge_cutoff: "early 2026" }).knowledgeCutoff, null);
});

test("the lead sentence does not repeat the title", () => {
  const glm = splitDescription({
    ratings: [],
    canonical_name: "GLM-5.3",
    description:
      "GLM-5.3 is Z.ai's flagship large language model built for complex software engineering. It reuses the GLM-5.2 base model. The model offers a 1M-token context window.",
  });
  assert.equal(glm.lead, "Z.ai's flagship large language model built for complex software engineering.");
  assert.equal(glm.rest, "It reuses the GLM-5.2 base model. The model offers a 1M-token context window.");
  // Decimals and "Z.ai" are not sentence ends.
  const kimi = splitDescription({
    ratings: [],
    canonical_name: "Kimi K3.1 Pro",
    description: "Kimi K3.1 Pro is Moonshot AI's model with a 2.8T-parameter MoE and 104B active parameters. It accepts images.",
  });
  assert.equal(kimi.lead, "Moonshot AI's model with a 2.8T-parameter MoE and 104B active parameters.");
  // A name that is not the opening subject is left alone.
  const plain = splitDescription({
    ratings: [],
    canonical_name: "Auto",
    description: "Routes each request to a model. It adds no fee.",
  });
  assert.deepEqual(plain, { lead: "Routes each request to a model.", rest: "It adds no fee." });
  // A sentence about the model keeps its place even when it mentions the
  // listing; one whose subject is the listing moves below.
  const mentioned = splitDescription({
    ratings: [],
    canonical_name: "GPT Image 2",
    description:
      "GPT Image 2 is OpenAI's image generation model, exposed through the GPT-5.4 Image 2 listing that pairs it with GPT-5.4. It is best at text-to-image generation and in-image text.",
  });
  assert.equal(mentioned.lead, "OpenAI's image generation model, exposed through the GPT-5.4 Image 2 listing that pairs it with GPT-5.4.");
  const housekeeping = splitDescription({
    ratings: [],
    canonical_name: "GPT-5.1",
    description:
      "OpenRouter's openai/gpt-5.1-latest entry resolves to gpt-5.1-2025-11-13. It is built for coding agents. The context is 400K.",
  });
  assert.equal(housekeeping.lead, "Built for coding agents.");
  assert.ok(housekeeping.rest.startsWith("OpenRouter's openai/gpt-5.1-latest entry resolves"));
  // "It is a …" names a thing and is left as it is.
  assert.equal(splitDescription({ ratings: [], description: "It is a router that picks a model for each request." }).lead, "It is a router that picks a model for each request.");
  // The maker's name in front of the model's goes with it.
  const branded = splitDescription({
    ratings: [],
    canonical_name: "GPT-5.6 Sol",
    vendor: "OpenAI",
    description: "OpenAI GPT-5.6 Sol is the flagship model for coding and agentic work. It has a 400K context.",
  });
  assert.deepEqual(branded, {
    lead: "The flagship model for coding and agentic work.",
    rest: "It has a 400K context.",
  });
  // One sentence, nothing to expand.
  assert.deepEqual(splitDescription({ ratings: [], description: "Only one sentence." }), {
    lead: "Only one sentence.",
    rest: "",
  });
  // A very long first sentence is cut at a clause; nothing is lost.
  const clause = "A very long opening clause about the model, ";
  const long = splitDescription({
    ratings: [],
    description: `${clause.repeat(9)}and it ends here. Second sentence.`,
  });
  assert.ok(long.lead.length <= 220);
  assert.ok(long.lead.startsWith(clause));
  assert.ok(long.rest.startsWith("A very long"));
  assert.ok(long.rest.endsWith("and it ends here. Second sentence."));
});

test("one benchmark family per name, however the researcher spells it", () => {
  const family = (metric) => benchmarkOf(rating(metric, 50)).id;
  // A stated version is part of the family: the scale changes with it.
  assert.equal(family("Intelligence Index v5.0.1"), "intelligence index v5");
  assert.equal(family("Intelligence Index v4.3.2 (open-weights rank #4/118)"), "intelligence index v4");
  assert.equal(benchmarkOf(rating("Intelligence Index v5.0.1 (Low effort)", 54)).label, "Intelligence Index v5");
  assert.equal(family("Artificial Analysis Intelligence Index"), "intelligence index");
  assert.equal(family("AA Intelligence Index"), "intelligence index");
  assert.equal(family("GPQA Diamond (Anthropic provider)"), "gpqa diamond");
  assert.equal(family("GPQA (%)"), "gpqa diamond");
  assert.equal(family("SWE-bench Verified"), "swe-bench verified");
  assert.equal(family("SWE-bench Pro"), "swe-bench pro");
  assert.equal(family("SWE-bench"), "swe-bench");
  // A version is part of the test.
  assert.equal(family("Terminal Bench 4.0"), "terminal-bench 4.0");
  assert.equal(family("Terminal-Bench 2.1"), "terminal-bench 2.1");
  assert.equal(family("Terminal-Bench"), "terminal-bench");
  assert.equal(family("DeepSWE v1.1"), "deepswe 1.1");
  assert.equal(family("MMLU-Pro"), "mmlu-pro");
  assert.equal(family("MMLU"), "mmlu");
  assert.equal(family("WebDev Elo"), "webdev arena elo");
  assert.equal(family("Arena Hard v2"), "lmarena elo");
  assert.equal(benchmarkOf(rating("GPQA Diamond", 95)).label, "GPQA Diamond");
  // An unknown benchmark keeps its own name, comparable only with itself.
  const other = benchmarkOf(rating("CyberGym (%)", 84.5, "Z.ai GLM-5.3 blog"));
  assert.equal(other.label, "CyberGym");
  assert.equal(other.id, "cybergym");
  const unknown = benchmarkOf(rating("Great Commission Benchmark", 61, "Great Commission Benchmark"));
  assert.equal(unknown.id, "great commission benchmark");
  assert.equal(benchmarkOf(rating("", 1)).label, "Score");
});

test("a qualifier is a variant, not a second benchmark", () => {
  const low = benchmarkOf(rating("Intelligence Index v5.0.1 (Low, default fallback)", 54));
  assert.equal(low.label, "Intelligence Index v5");
  // Whatever else it says, the setting is a low effort.
  assert.equal(low.variant, "low effort");
  const plain = benchmarkOf(rating("Intelligence Index v5.0.1", 60));
  assert.equal(plain.variant, null);
  const noTools = benchmarkOf(rating("HLE without tools", 31, "DeepSeek API Docs"));
  assert.equal(noTools.label, "HLE");
  assert.equal(noTools.variant, "without tools");
  const effort = benchmarkOf(rating("Z.ai Code Bench max effort (%)", 34.5, "Z.ai GLM-5.3 blog"));
  assert.equal(effort.label, "Z.ai Code Bench");
  assert.equal(effort.variant, "max effort");
  // A word that is the whole name is not a qualifier.
  assert.equal(benchmarkOf(rating("Reasoning", 70)).label, "Reasoning");
  assert.equal(benchmarkOf(rating("Reasoning accuracy", 70)).variant, null);
});

test("who measured is known and shown", () => {
  const kind = (source, vendor = "Z.ai (Zhipu AI)") => sourceKind(source, vendor);
  assert.equal(kind("Artificial Analysis"), "lab");
  assert.equal(kind("Artificial Analysis (reported by CGTN)"), "lab");
  assert.equal(kind("Epoch AI"), "lab");
  assert.equal(kind("OpenRouter blog (DRACO benchmark)", "xAI"), "lab");
  assert.equal(kind("Z.ai GLM-5.3 blog"), "vendor");
  assert.equal(kind("Moonshot AI (vendor-reported)", "Moonshot AI"), "vendor");
  assert.equal(kind("DeepSeek API Docs", "DeepSeek"), "vendor");
  assert.equal(kind("NVIDIA model card (Hugging Face)", "NVIDIA"), "vendor");
  assert.equal(kind("Hugging Face model card", "Meta"), "vendor");
  assert.equal(kind("Vercel AI Gateway"), "community");
  assert.equal(benchmarkOf(rating("HLE", 30, "Tokenator / Artificial Analysis")).source, "Artificial Analysis");
  assert.equal(benchmarkOf(rating("HLE", 30, "Z.ai GLM-5.3 blog")).source, "Z.ai GLM-5.3 blog");
});

test("one score per family: the default variant from the most independent source", () => {
  const scores = scoresOf(
    [
      rating("Intelligence Index v5.0.1 (Low, default fallback)", 54, "Artificial Analysis", "2026-11"),
      rating("Intelligence Index v5.0.1 (Xhigh)", 62, "Artificial Analysis", "2026-11"),
      rating("Intelligence Index", 58, "OpenRouter", "2026-10"),
      rating("Intelligence Index", 71, "Z.ai blog", "2026-11"),
      rating("GPQA Diamond", 95.1, "OpenRouter", "2026-11"),
      rating("value", 3),
      { ...rating("Broken", Number.NaN) },
    ],
    "Z.ai",
  );
  // A stated version is its own family; the unversioned one stays apart
  // until the catalog's eras say which version it belongs to.
  assert.deepEqual([...scores.keys()].sort(), ["gpqa diamond", "intelligence index", "intelligence index v5"]);
  assert.equal(scores.get("intelligence index").rating.value, 58);
  assert.equal(scores.get("intelligence index").benchmark.kind, "lab");
  // With the eras of a catalog, a card dated after v5 first appeared is read as v5.
  const eras = indexEras([
    { ratings: [{ metric: "Intelligence Index v5", value: 1, source: "Lab", as_of: "2025-12" }] },
    { ratings: [{ metric: "Intelligence Index v4.1", value: 1, source: "Lab", as_of: "2025-05" }] },
  ]);
  assert.deepEqual(eras, { "intelligence index": { latest: "5", since: "2025-12" } });
  const dated = scoresOf(
    [
      rating("Intelligence Index v5.0.1 (Low, default fallback)", 54, "Artificial Analysis", "2026-11"),
      rating("Intelligence Index", 58, "OpenRouter", "2026-10"),
      rating("Intelligence Index", 68, "Artificial Analysis", "2025-05"),
      rating("Intelligence Index v4.1.1", 61, "Artificial Analysis", "2025-06"),
    ],
    "Z.ai",
    eras,
  );
  assert.deepEqual([...dated.keys()].sort(), ["intelligence index before v5", "intelligence index v4", "intelligence index v5"]);
  assert.equal(dated.get("intelligence index v5").rating.value, 58);
  assert.equal(dated.get("intelligence index before v5").rating.value, 68);
  assert.equal(dated.get("intelligence index v4").rating.value, 61);
  // Another site's index is on another scale, so it is another benchmark.
  assert.equal(
    benchmarkOf(rating("Intelligence Index (composite)", 88, "TrustTheBench", "2026-10"), null, eras).id,
    "intelligence index v5 · trustthebench",
  );
  // Without a default variant the plainest measurement of the best source wins.
  const only = scoresOf(
    [
      rating("Intelligence Index (High)", 60, "Vendor blog"),
      rating("Intelligence Index (Low)", 50, "Artificial Analysis"),
    ],
    "Vendor",
  );
  assert.equal(only.get("intelligence index").rating.value, 50);
  assert.equal(scoresOf(null).size, 0);
  assert.equal(scoresOf([]).size, 0);
});

test("a license reads one way, however the card wrote it", () => {
  assert.equal(licenseLabel("Proprietary"), "proprietary");
  assert.equal(licenseLabel("CC-BY-NC-4.0"), "CC BY-NC 4.0");
  assert.equal(licenseLabel("CC BY-NC 4.0"), "CC BY-NC 4.0");
  assert.equal(licenseLabel("cc-by-sa 4.0"), "CC BY-SA 4.0");
  // What follows the license is kept; a proprietary name is not rewritten.
  assert.equal(licenseLabel("CC-BY-NC 4.0 with Acceptable Use Addendum"), "CC BY-NC 4.0 with Acceptable Use Addendum");
  assert.equal(licenseLabel("Llama 3.1 Community License"), "Llama 3.1 Community License");
  assert.equal(licenseLabel("DeepSeek   License"), "DeepSeek License");
});

test("one effort setting reads one way, however the card wrote it", () => {
  const variant = (metric, note = null) => benchmarkOf(rating(metric, 50, "Artificial Analysis", "2026-10", note)).variant;
  assert.equal(variant("Intelligence Index v5 (Max)"), "max effort");
  assert.equal(variant("Intelligence Index v5 (High reasoning effort)"), "high effort");
  assert.equal(variant("Intelligence Index v5, max reasoning"), "max effort");
  assert.equal(variant("Intelligence Index v5", "Max effort; Artificial Analysis Intelligence Index v5.0."), "max effort");
  assert.equal(variant("Intelligence Index v5 (Xhigh)"), "xhigh effort");
  // A condition that is not an effort keeps its words.
  assert.equal(variant("SWE-bench Verified (without tools)"), "without tools");
  assert.equal(variant("Intelligence Index v5 (launch article)"), "launch article");
  // "High" inside another word is no setting.
  assert.equal(variant("Intelligence Index v5 (highlighted run)"), "highlighted run");
  // The version a note states counts when the name has none.
  assert.equal(
    benchmarkOf(rating("Intelligence Index", 50, "Artificial Analysis", "2026-10", "Max effort; Intelligence Index v4.0.")).label,
    "Intelligence Index v4",
  );
  assert.equal(
    benchmarkOf(rating("Intelligence Index v5", 50, "Artificial Analysis", "2026-10", "Quoted from Intelligence Index v4.0.")).label,
    "Intelligence Index v5",
  );
});

test("between two efforts the lower one is the number shown", () => {
  const card = {
    ratings: [
      // The version is in the notes, so both readings are one benchmark.
      rating("Intelligence Index", 58, "Artificial Analysis", "2026-11", "Max effort; Artificial Analysis Intelligence Index v5.0."),
      rating("Intelligence Index", 52, "Artificial Analysis", "2026-11", "High effort; Artificial Analysis Intelligence Index v5.0."),
      rating("Terminal-Bench 4.0", 59.6, "Artificial Analysis", "2026-11", "Max effort; independently run."),
      rating("Terminal-Bench 4.0", 66.4, "Anthropic", "2026-09", "Vendor-run; xhigh effort."),
    ],
  };
  const shown = scoresOf(card.ratings, "Anthropic", {});
  assert.equal(shown.get("intelligence index v5").rating.value, 52);
  assert.equal(shown.get("intelligence index v5").benchmark.variant, "high effort");
  // The lab's number still outranks the vendor's, whatever the effort.
  assert.equal(shown.get("terminal-bench 4.0").rating.value, 59.6);
  // A reading without any setting outranks both.
  card.ratings.push(rating("Intelligence Index v5", 49, "Artificial Analysis", "2026-11"));
  assert.equal(scoresOf(card.ratings, "Anthropic", {}).get("intelligence index v5").rating.value, 49);
});

test("the readings not shown stay listed beside the one that is", () => {
  const card = {
    ratings: [
      rating("Intelligence Index", 58, "Artificial Analysis", "2026-11", "Max effort; Artificial Analysis Intelligence Index v5.0."),
      rating("Intelligence Index", 52, "Artificial Analysis", "2026-11", "High effort; Artificial Analysis Intelligence Index v5.0."),
      rating("Terminal-Bench 4.0", 59.6, "Artificial Analysis", "2026-11", "Max effort; independently run."),
      rating("Terminal-Bench 4.0", 66.4, "Anthropic", "2026-09", "Vendor-run; xhigh effort."),
      // The same reading again, a month older: nothing new to show.
      rating("Terminal-Bench 4.0", 58, "Artificial Analysis", "2026-08", "Max effort; independently run."),
    ],
  };
  const rest = otherScoresOf(card.ratings, "Anthropic", {});
  assert.deepEqual(
    [...rest].map(([id, others]) => [id, others.map((other) => `${other.benchmark.variant}/${other.benchmark.kind}:${other.rating.value}`)]).sort(),
    [
      ["intelligence index v5", ["max effort/lab:58"]],
      ["terminal-bench 4.0", ["xhigh effort/vendor:66.4"]],
    ],
  );
  // Sorted best first, and nothing for a card without readings.
  assert.equal(otherScoresOf([], "Anthropic", {}).size, 0);
});

test("source hosts read as the site", () => {
  assert.equal(sourceHost("https://platform.claude.com/docs/en/models/fable-5-2/overview"), "claude.com");
  assert.equal(sourceHost("https://docs.z.ai/guides/llm/glm-5.3"), "z.ai");
  assert.equal(sourceHost("https://z.ai/blog/glm-5.3"), "z.ai");
  assert.equal(sourceHost("https://www.alibabacloud.com/help/en/model-studio/glm-5-3"), "alibabacloud.com");
  assert.equal(sourceHost("https://integrate.api.nvidia.com/v1"), "nvidia.com");
  assert.equal(sourceHost("https://artificialanalysis.ai/models/claude-fable-5-2-low"), "artificialanalysis.ai");
  assert.equal(sourceHost("https://eu.36kr.com/en/p/4039"), "36kr.com");
  assert.equal(sourceHost("https://github.com/QwenLM/Qwen3"), "github.com");
  assert.equal(sourceHost("not a url"), "not a url");
});

console.log(`${checks} model-facts checks passed`);
