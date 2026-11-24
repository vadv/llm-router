// A comparable view of a researched model card. Cards are written by an LLM
// with web search, so their text is free-form: one vendor has six spellings
// and one benchmark has a dozen. Everything here reads what the card says
// and never adds a value of its own. Older cards carry only prose; newer
// ones also carry the structured fields, which win when present.

import type { KnowledgeCard, KnowledgeRating } from "./api";

/// Anything card-shaped: a full card or the summary the catalog index sends.
export type CardLike = Partial<{ [K in keyof KnowledgeCard]: KnowledgeCard[K] | null }>;

// ---- Vendor ----

// Long-tail vendors fall back to their name before a parenthesis or slash.
const VENDORS: [RegExp, string][] = [
  [/anthropic/, "Anthropic"],
  [/openai/, "OpenAI"],
  [/deepseek/, "DeepSeek"],
  [/z\.?\s?ai|zhipu/, "Z.ai"],
  [/moonshot|kimi/, "Moonshot AI"],
  [/alibaba|qwen|dashscope|tongyi/, "Alibaba"],
  [/google|deepmind|gemma/, "Google"],
  [/\bmeta\b|facebook|llama/, "Meta"],
  [/mistral/, "Mistral AI"],
  [/\bxai\b|x\.ai|grok/, "xAI"],
  [/nvidia/, "NVIDIA"],
  [/microsoft/, "Microsoft"],
  [/xiaomi|mimo/, "Xiaomi"],
  [/minimax/, "MiniMax"],
  [/tencent|hunyuan|\bhy4/, "Tencent"],
  [/cohere/, "Cohere"],
  [/perplexity/, "Perplexity"],
  [/amazon|\baws\b/, "Amazon"],
  [/bytedance|doubao/, "ByteDance"],
  [/inclusionai|inclusion ai|\bling-/, "InclusionAI"],
  [/aion ?labs/, "Aion Labs"],
  [/perceptron/, "Perceptron"],
  [/thinking machines/, "Thinking Machines Lab"],
  [/upstage/, "Upstage"],
  [/nex[-\s]?agi/, "Nex AGI"],
  [/\bbaidu\b/, "Baidu"],
  [/stepfun/, "StepFun"],
  [/snowflake/, "Snowflake"],
  [/\bibm\b/, "IBM"],
];

/// The vendor as one stable label, so a filter lists "Alibaba" once.
export function canonicalVendor(vendor: string | null | undefined): string | null {
  const name = vendor?.trim();
  if (!name) return null;
  const hit = VENDORS.find(([pattern]) => pattern.test(name.toLowerCase()));
  if (hit) return hit[1];
  const head = name.split(/\s*[(/,]|\s+Inc\.?$/)[0].trim();
  return head || name;
}

// ---- Pricing ----

export type Pricing = {
  /// Currency code as the card writes it.
  currency: string;
  /// List price per one million tokens.
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  /// Both directions are priced at zero.
  free: boolean;
  /// The researcher's sentence; it often says more than the numbers do.
  note: string | null;
};

const CURRENCIES = "USD|EUR|GBP|CNY|RMB|JPY|KRW|INR";
// "$8", "8 USD", and the form Chinese providers write, "RMB 1".
const AMOUNT = new RegExp(
  `(?:US\\$|\\$|€|£|₹|₩|¥)\\s?(\\d+(?:\\.\\d+)?)|\\b(\\d+(?:\\.\\d+)?)\\s?(${CURRENCIES})\\b|\\b(${CURRENCIES})\\s(\\d+(?:\\.\\d+)?)`,
  "g",
);
const SYMBOL: Record<string, string> = {
  US$: "USD",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "₩": "KRW",
  "¥": "JPY",
};
// Words between a direction and its figure: "is", "are each priced at",
// "around". Any number of them, in any order.
const LINK = String.raw`(?:\s*(?:is|are|costs?|at|from|each|priced|about|only|roughly|around|approximately)|:)*\s*`;
// A direction named before its price: "Input is $0.30", "cache reads at $0.20".
const LEAD: [Direction, RegExp][] = [
  ["cachedInput", new RegExp(String.raw`(?:cach\w*[-\s](?:reads?|hits?)|cached[-\s]input)(?:\s+input)?${LINK}$`, "i")],
  ["input", new RegExp(String.raw`(?:input|prompt)${LINK}$`, "i")],
  ["output", new RegExp(String.raw`(?:output|completion)${LINK}$`, "i")],
];
// A direction named after its price: "$8 per 1M input tokens".
const TRAIL: [Direction, RegExp][] = [
  ["cachedInput", /cach\w*[-\s](?:reads?|hits?)|cached[-\s]input/],
  ["input", /input|prompt|cache[-\s]miss/],
  ["output", /output|completion/],
];
// "$60 per 1M image output tokens" is not the price of text output. "text
// +audio output" still is: text is in the mix.
const MEDIA = /(?:image|audio|video|song|clip|minute|per[-\s]min)\b[-\s]*$/i;
const MIXED_TEXT = /\btext\s*[+&,]\s*(?:and\s+)?(?:\w+\s*[+&,]?\s*)*$/i;
// "$16/$80" or "$1.4/M/$4.4/M". A unit of the previous price ("$10/M input
// tokens, $50/M") is not a pair.
const PAIR = /^\s*(?:\/\s*(?:1\s?m|mtok|m|k|million)\b\s*)?\/\s*$/i;
const PER_THOUSAND = /per\s+1k\b|\/\s*1k\b|1,000\s+tokens|thousand\s+tokens/i;
const PER_MILLION = /per\s+1m\b|\/\s*1m\b|\/\s*mtok|million/i;
type Direction = "input" | "cachedInput" | "output";
type Role = Direction | "both" | "media";
type Price = { at: number; end: number; value: number; currency: string };

function readAmounts(text: string): Price[] {
  const prices: Price[] = [];
  for (const match of text.matchAll(AMOUNT)) {
    const symbol = /^(US\$|\$|€|£|₹|₩|¥)/.exec(match[0])?.[1];
    prices.push({
      at: match.index,
      end: match.index + match[0].length,
      value: Number(match[1] ?? match[2] ?? match[5]),
      currency: symbol ? SYMBOL[symbol] : (match[3] ?? match[4] ?? "USD").replace("RMB", "CNY"),
    });
  }
  return prices.filter((price) => Number.isFinite(price.value));
}

/// Which direction a figure belongs to: named right before it, or by the
/// nearest direction word after it. "both" is "$0.00 input/output", "media"
/// a price per image, song or minute.
function roleOf(before: string, after: string): Role | null {
  const media = MEDIA.exec(before);
  if (media && LEAD.some(([, pattern]) => pattern.test(before.slice(media.index)))) return "media";
  const lead = LEAD.findIndex(([, pattern]) => pattern.test(before));
  if (lead >= 0) {
    const [direction, pattern] = LEAD[lead];
    // "input and output are each priced at $0.15"
    const both =
      direction === "output" &&
      /(?:input|prompt)\s*(?:and|&|,)\s*$/i.test(before.slice(0, before.length - pattern.exec(before)![0].length));
    return both ? "both" : direction;
  }
  let best: [Direction, number] | null = null;
  for (const [direction, pattern] of TRAIL) {
    const at = new RegExp(pattern.source, "gi").exec(after)?.index;
    if (at !== undefined && (best === null || at < best[1])) best = [direction, at];
  }
  if (!best) return null;
  const prefix = after.slice(0, best[1]);
  if (MEDIA.test(prefix) && !MIXED_TEXT.test(prefix)) return "media";
  if (best[0] === "input" && /^\s*(?:\/|and\s+|&\s*)output/.test(after.slice(best[1] + 5)))
    return "both";
  return best[0];
}

/// The list price in a sentence: the input and output figures that stand
/// next to each other, so both come from the same listing. A sentence often
/// names several listings; mixing two of them would invent a price.
function readSentence(hint: string): Pricing | null {
  const figures = readAmounts(hint);
  // The second half of "$16/$80" names no direction of its own.
  const halves = figures.map((price, index) =>
    index > 0 ? PAIR.test(hint.slice(figures[index - 1].end, price.at)) : false,
  );
  const found: { price: Price; role: Role | null }[] = [];
  figures.forEach((price, index) => {
    if (halves[index]) return;
    const previous = found.at(-1)?.price;
    const next = figures.findIndex((_, j) => j > index && !halves[j]);
    const after = hint.slice(price.end, Math.min(figures[next]?.at ?? Infinity, price.end + 64));
    // The direction may be named anywhere since the previous figure.
    const role = roleOf(hint.slice(previous?.end ?? 0, price.at), after);
    found.push({ price, role });
  });
  // The latest input before the first output is the pair; a cached figure
  // sits next to it.
  let pending = -1;
  let pair: [number, number] | null = null;
  for (const [index, { role }] of found.entries()) {
    if (role === "both") {
      pair = [index, index];
      break;
    }
    if (role === "input") pending = index;
    else if (role === "output" && pending >= 0) {
      pair = [pending, index];
      break;
    }
  }
  if (!pair) return null;
  const [input, output] = pair.map((index) => found[index].price);
  const cached = [...found.slice(pair[0] + 1, pair[1]), found[pair[1] + 1], found[pair[0] - 1]].find(
    (item) => item?.role === "cachedInput",
  )?.price;
  // "per 1K" figures are read as written, so they are scaled to one million.
  const perMillion = (price: Price) => {
    const index = figures.indexOf(price);
    const clause = hint.slice(figures[Math.max(0, index - 1)].end, figures[index + 2]?.at ?? hint.length);
    return PER_THOUSAND.test(clause) && !PER_MILLION.test(clause) ? price.value * 1000 : price.value;
  };
  return {
    currency: input.currency,
    input: perMillion(input),
    cachedInput: cached ? perMillion(cached) : null,
    output: perMillion(output),
    free: input.value === 0 && output.value === 0,
    note: hint,
  };
}

/// List prices of a card. The structured `pricing` object wins; the older
/// cards only have a sentence, which is read. Null when neither says what
/// both directions cost.
export function parsePricing(card: CardLike): Pricing | null {
  const hint = card.pricing_hint?.trim() || null;
  const structured = card.pricing;
  if (structured && (structured.input_per_1m != null || structured.output_per_1m != null))
    return {
      currency: structured.currency?.trim() || "USD",
      input: structured.input_per_1m,
      cachedInput: structured.cached_input_per_1m ?? null,
      output: structured.output_per_1m,
      free: structured.input_per_1m === 0 && structured.output_per_1m === 0,
      note: structured.note?.trim() || hint,
    };
  return hint ? readSentence(hint) : null;
}

/// "$1.131" keeps the third decimal the researcher wrote; "$8" stays "$8".
export function priceAmount(value: number): string {
  const abs = Math.abs(value);
  return value.toFixed(abs !== 0 && abs < 0.01 ? 5 : 3).replace(/\.?0+$/, "");
}

export function priceText(value: number | null | undefined, currency = "USD"): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${currency === "USD" ? "$" : `${currency} `}${priceAmount(value)}`;
}

// ---- Specs ----

export const MODALITIES = ["text", "image", "video", "audio", "pdf"] as const;
export type Modality = (typeof MODALITIES)[number];

// What a model is for, in the words the research schema asks for.
export const TAGS = [
  "coding",
  "agents",
  "reasoning",
  "math",
  "vision",
  "audio",
  "long-context",
  "fast",
  "cheap",
  "chat",
  "writing",
  "multilingual",
  "embedding",
  "image-generation",
  "speech",
  "roleplay",
  "open-weights",
  "on-device",
] as const;
export type Tag = (typeof TAGS)[number];
export const TAG_LABELS: Record<Tag, string> = {
  coding: "Coding",
  agents: "Agents",
  reasoning: "Reasoning",
  math: "Math",
  vision: "Vision",
  audio: "Audio",
  "long-context": "Long context",
  fast: "Fast",
  cheap: "Cheap",
  chat: "Chat",
  writing: "Writing",
  multilingual: "Multilingual",
  embedding: "Embeddings",
  "image-generation": "Image generation",
  speech: "Speech",
  roleplay: "Roleplay",
  "open-weights": "Open weights",
  "on-device": "On-device",
};

// Use-case words of the older cards, read strictly: a tag is inferred only
// from the phrase the researcher wrote as the model's first use.
const INFERRED: [RegExp, Tag][] = [
  [/\bcod(?:e|ing|er)\b|programming|software engineer|\brepos?\b|repositor|front[-\s]?end|debugg/i, "coding"],
  [/\bagent/i, "agents"],
  [/\breasoning\b|\bthink/i, "reasoning"],
  [/\bmath\b/, "math"],
  [/\bembed|retrieval|rerank|semantic search/i, "embedding"],
  [/multilingual|translat|\blanguages\b/i, "multilingual"],
  [/image (?:generation|editing)|text-to-image|\bdraw/i, "image-generation"],
  [/transcri|text-to-speech|\bbbs\b|\btts\b/i, "speech"],
  [/roleplay|role-play|creative writing|storytell/i, "roleplay"],
  [/\bchat\b|chatbot|conversation/i, "chat"],
];

/// A flag as the card states it. Older indexes write `true` as `1`.
function flagOf(value: unknown): boolean | null {
  return value === true || value === 1 ? true : value === false || value === 0 ? false : null;
}

/// What a model is for. Cards from the current schema carry the list. What
/// the card states as numbers is read for every card: open weights, image
/// input, a low price, a high speed. Only a card without a stated list has
/// its uses read from its first use case, and one that says nothing claims
/// nothing.
export function tagsOf(card: CardLike, primaryUse?: string | null): Tag[] {
  const stated: Tag[] = [];
  for (const raw of Array.isArray(card.tags) ? card.tags : []) {
    const tag = String(raw).trim().toLowerCase();
    if ((TAGS as readonly string[]).includes(tag) && !stated.includes(tag as Tag))
      stated.push(tag as Tag);
  }
  const found = new Set<Tag>(stated);
  // What the card states about the model, the tags say too.
  const specs = modelSpecs(card);
  if (specs.openWeights === true) found.add("open-weights");
  if (specs.input.includes("image")) found.add("vision");
  if (specs.input.includes("audio")) found.add("audio");
  if (specs.output.includes("image")) found.add("image-generation");
  if (specs.context !== null && specs.context >= 262_144) found.add("long-context");
  const pricing = parsePricing(card);
  if (
    pricing?.currency === "USD" &&
    pricing.input !== null &&
    pricing.output !== null &&
    pricing.input <= 0.6 &&
    pricing.output <= 2.5
  )
    found.add("cheap");
  const tokensPerSecond = card.speed?.output_tokens_per_second;
  if (typeof tokensPerSecond === "number" && tokensPerSecond >= 60) found.add("fast");
  // A use is read from prose only when the card states none: a stated list
  // is the researcher's answer, and guessing more would talk over it.
  if (!stated.length)
    for (const [pattern, tag] of INFERRED) if (pattern.test(primaryUse ?? "")) found.add(tag);
  return TAGS.filter((tag) => found.has(tag));
}

export type Specs = {
  context: number | null;
  maxOutput: number | null;
  input: Modality[];
  output: Modality[];
  license: string | null;
  openWeights: boolean | null;
  parameters: string | null;
  knowledgeCutoff: string | null;
  /// "always": the model cannot skip its reasoning. "optional": the caller
  /// chooses. "none": a plain instruct model.
  reasoning: "always" | "optional" | "none" | null;
  toolCalling: boolean | null;
};

const MODALITY_WORDS: [RegExp, Modality][] = [
  [/\btext\b/, "text"],
  [/\bimage|vision|visual|photo|screenshot/, "image"],
  [/\bvideo\b/, "video"],
  [/\baudio|speech|voice\b/, "audio"],
  [/\bpdf\b|\bfiles?\b|\bdocuments?\b/, "pdf"],
];

/// The modalities a piece of prose names, or null when it names none.
function named(segment: string): Modality[] | null {
  const found = MODALITIES.filter((_, index) => MODALITY_WORDS[index][0].test(segment));
  return found.length ? found : null;
}

function structuredModalities(values: unknown): Modality[] | null {
  return Array.isArray(values) ? named(values.filter((v) => typeof v === "string").join(" ")) : null;
}

/// Older cards say "Text, image, and file input; text output".
function proseModalities(modality: string | null | undefined): { input: Modality[]; output: Modality[] } {
  const text = (modality ?? "").toLowerCase();
  const all = named(text);
  const words = (segment: string | undefined) => named(segment ?? "") ?? [];
  if ((/\btext[-\s]only\b|\btext[-\s]to[-\s]text\b/.test(text)) && (!all || all.length === 1))
    return { input: ["text"], output: ["text"] };
  const arrow = text.split(/\s*(?:→|->|-to-|\bto\b)\s*/);
  if (arrow.length === 2 && !/\binputs?\b|\boutputs?\b/.test(text))
    return { input: words(arrow[0]), output: words(arrow[1]) };
  const at = text.search(/\binputs?\b/);
  const out = text.search(/\boutputs?\b/);
  // Nothing says what comes out, so it is what every model writes.
  if (at < 0 || out < at) return { input: all ?? ["text"], output: ["text"] };
  // "Multimodal input (text, image)" and "Multimodal input: text, image"
  // list what goes in after the word.
  const listed = /^\s*(?:\(([^)]*)\)|:\s*([^;.(]*))/.exec(text.slice(text.indexOf(" ", at) + 1));
  const before = text.slice(0, at).split(/[;.(]/).pop();
  const between = (text.slice(at + 5, out).replace(/\([^)]*\)/g, " ").split(/[;.(]/).pop() ?? "")
    .replace(/^\s*(?:and|with|to)\s+/, "");
  const after = /^[^a-z]*([a-z,\s]+?)(?:\b(?:only|model|token|varying|depending)|$)/.exec(text.slice(out + 6))?.[1];
  return {
    input: named(`${before} ${listed?.[1] ?? listed?.[2] ?? ""}`) ?? all ?? ["text"],
    output: named(between) ?? named(after ?? "") ?? all?.filter((m) => m === "text") ?? ["text"],
  };
}

const SIZE = /(\d[\d,]*(?:\.\d+)?)\s*(k|m)\b/i;
function tokens(text: string): number | null {
  if (!text.trim()) return null;
  const size = SIZE.exec(text);
  const value = Number((size ? size[1] : text).replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return size ? value * (size[2].toLowerCase() === "m" ? 1_000_000 : 1000) : value;
}
const MAX_OUTPUT =
  /(\d[\d,.]*\s*[km]?)(?:[-\s]tokens?)?\s*(?:max(?:imum)?\s+output|output\s+(?:limit|cap))|max(?:imum)?\s+output\s+(?:of\s+)?(\d[\d,.]*\s*[km]?)(?:[-\s]tokens?)?/i;
const LICENSE =
  /\b(?:Apache[-\s]2\.0|MIT[ -]licen[sc]e|MIT|Llama \d(?:\.\d)? Community|Qwen Research|Gemini Terms|GPL-?3(?:\.0)?|AGPL-?3(?:\.0)?|BSD-?[23]?|CC[-\s]BY(?:-[A-Z]+)*|OpenRAIL-M)\b/;
/// A license as one steady label. The same text arrives as "CC-BY-NC-4.0"
/// and "CC BY-NC 4.0", as "Proprietary" and "proprietary".
export function licenseLabel(raw: string): string {
  const text = raw.trim().replace(/\s+/g, " ");
  if (/^(?:proprietary|closed(?:[-\s]source| weights)?)$/i.test(text)) return "proprietary";
  return text.replace(
    /\bCC[-\s](BY(?:-(?:NC|ND|SA|NC-SA|NC-ND))?)[- ]?(\d(?:\.\d)?)\b/i,
    (_match: string, terms: string | undefined, version: string) =>
      `CC ${(terms ?? "").toUpperCase()} ${version}`,
  );
}
const OPEN_WEIGHTS =
  /\bopen[-\s]weights?\b|open[-\s]source model|weights (?:are |were )?(?:available |released |published )?(?:on|via|through)\b/i;

/// Facts the card states as numbers or flags, with prose fallbacks for the
/// cards collected before the structured fields existed.
export function modelSpecs(card: CardLike): Specs {
  const prose = [card.description, card.family_line, ...(card.strengths ?? []), ...(card.weaknesses ?? [])]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  const fallback = proseModalities(card.modality);
  const reasoning = card.reasoning;
  return {
    context: card.context_window ?? null,
    maxOutput: card.max_output_tokens ?? tokens(MAX_OUTPUT.exec(prose)?.slice(1).find(Boolean) ?? ""),
    input: structuredModalities(card.input_modalities) ?? fallback.input,
    output: structuredModalities(card.output_modalities) ?? fallback.output,
    license: licenseLabel(card.license?.trim() || LICENSE.exec(prose)?.[0].replace(/\s+/g, " ") || "") || null,
    openWeights: flagOf(card.open_weights) ?? (OPEN_WEIGHTS.test(prose) ? true : null),
    parameters: card.parameters?.trim() || null,
    knowledgeCutoff: isDate(card.knowledge_cutoff) ? card.knowledge_cutoff : null,
    reasoning: reasoning === "always" || reasoning === "optional" || reasoning === "none" ? reasoning : null,
    toolCalling: flagOf(card.tool_calling),
  };
}

// ---- Prose ----

const LEAD_CAP = 220;
const ALIAS_OPENER =
  /\b(?:resolves? to|corresponds? to|refers? to|is (?:an? |the )?(?:rolling |moving )?(?:alias|pointer)|catalog (?:id|alias|entry)|listing)\b/i;

/// The first sentence of the description, with "Model is" cut off, so it
/// reads as a line under the title instead of repeating it.
export function splitDescription(card: CardLike): { lead: string; rest: string } {
  const text = (card.description ?? "").trim();
  const sentence = text.search(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(])/);
  let lead = (sentence < 0 ? text : text.slice(0, sentence)).trim();
  let rest = sentence < 0 ? "" : text.slice(sentence).trim();
  // Older cards often open with how a listing resolves ("OpenRouter's …
  // entry resolves to …"): the subject of the sentence is the listing, not
  // the model. That is catalog housekeeping: the first sentence about the
  // model leads, and the opening moves below it. A sentence that describes
  // the model and only mentions the listing further on stays in front.
  const subject = lead.split(/\s+(?:is|are)\s+/i)[0] ?? lead;
  if (ALIAS_OPENER.test(subject) && rest) {
    const next = rest.search(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(])/);
    const second = (next < 0 ? rest : rest.slice(0, next)).trim();
    const tail = next < 0 ? "" : rest.slice(next).trim();
    if (second.length >= 24) {
      lead = second;
      rest = [text.slice(0, sentence).trim(), tail].filter(Boolean).join(" ");
    }
  }
  if (lead.length > LEAD_CAP) {
    const clause = lead.lastIndexOf(", ", LEAD_CAP);
    const end = clause > 60 ? clause : lead.slice(0, LEAD_CAP).lastIndexOf(" ");
    lead = clause > 60 ? lead.slice(0, clause) : `${lead.slice(0, end)}…`;
    rest = text.slice(end).replace(/^[\s,;:]+/, "");
  }
  // A sentence that only says what the listing is ("It is best at …",
  // "It is designed for …") reads as the thing itself.
  lead = lead.replace(/^It is (?!a |an |the )(\w)/, (_, letter: string) => letter.toUpperCase());
  const name = card.canonical_name?.trim();
  // "AionLabs: Aion 3.5 is …": a titled name still opens the sentence short.
  const openers = name ? [name, name.split(":").pop()!.trim()] : [];
  // "OpenAI GPT-5 is …" names the maker first.
  for (const vendor of [card.vendor, canonicalVendor(card.vendor)]) {
    if (vendor && name) openers.push(`${vendor.trim()} ${name}`);
  }
  for (const opener of openers) {
    const pattern = new RegExp(`^${opener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:is|are)\\s+`, "i");
    const stripped = lead.replace(pattern, "").trim();
    if (stripped !== lead && stripped.length >= 24)
      return { lead: stripped[0].toUpperCase() + stripped.slice(1), rest };
  }
  return { lead, rest };
}

/// A date the card reports as "YYYY-MM" or "YYYY-MM-DD".
export function isDate(value: string | null | undefined): value is string {
  return !!value && /^\d{4}-\d{2}(-\d{2})?$/.test(value);
}

// ---- Benchmarks ----

export type Benchmark = {
  /// Stable id: the family for a known benchmark, the normalized metric otherwise.
  id: string;
  /// Name as shown, e.g. "Terminal-Bench 4.0".
  label: string;
  /// "Low effort", "without tools": what was measured, when the card says.
  variant: string | null;
  /// Who measured: an independent lab, the vendor itself, or a community site.
  kind: "lab" | "vendor" | "community";
  /// Source as shown, e.g. "Artificial Analysis".
  source: string;
};

// Matched against the lowercased source.
const LABS: [RegExp, string][] = [
  [/artificial analysis|(?<![a-z])aa(?![a-z])/, "Artificial Analysis"],
  [/epoch ai/, "Epoch AI"],
  [/lmarena|lm arena|chatbot arena|lmsys/, "LMArena"],
  [/openrouter/, "OpenRouter"],
  [/llm stats/, "LLM Stats"],
  [/vals ai|vals index/, "Vals AI"],
  [/scale ai/, "Scale AI"],
  [/livebench/, "LiveBench"],
  [/hugging ?face/, "Hugging Face"],
];
const VENDOR_PUBLICATION =
  /model card|\bofficial\b|documentation|\bdocs?\b|vendor|technical report|press release|research paper|\barxiv\b/i;
const VENDOR_NEWS = /\bblog\b|announcement/i;
// A qualifier at the end of a metric name: the same test under other conditions.
const QUALIFIER =
  /\b(?:(?:with(?:out)?|no)\s+tools?|reasoning(?:\s+mode)?|thinking(?:\s+mode)?|(?:low|medium|high|xhigh|max|minimal)(?:[-\s]effort)?(?:\s+(?:thinking|reasoning))?)\s*\)?\s*$/i;
// The effort levels, lowest first.
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_WORD = new RegExp(`\\b(${EFFORTS.join("|")})\\b`, "i");
const effortRank = (text: string): number | undefined => {
  const level = EFFORT_WORD.exec(text)?.[1]?.toLowerCase();
  return level ? EFFORTS.indexOf(level) : undefined;
};

/// A qualifier as one steady label. The same setting is written many ways
/// ("Max", "max reasoning", "High reasoning effort"); all of them read
/// "max effort", "high effort", so two readings of one setting compare.
function qualifierLabel(text: string): string {
  const level = EFFORT_WORD.exec(text)?.[1]?.toLowerCase();
  return level ? `${level} effort` : cleanMetric(text).toLowerCase();
}

// An effort level stated in a rating's note rather than in its name.
const EFFORT_NOTE =
  /\b(?:(?:with |at |using )?(?:reasoning )?effort\s+(?:set to |of |level )?|(?:default )?)(low|medium|high|xhigh|max|minimal)\b|\b(low|medium|high|xhigh|max|minimal)\s+(?:reasoning )?effort\b/i;
// "Overall score" means one thing on one site and another on the next, so
// such names only compare models scored by the same source.
const GENERIC =
  /^(?:overall(?: benchmark)?(?: score| rating)?|average(?: benchmark)? score|average|score|overall rating|performance rating)$/i;

/// "DeepSWE 1.1" and "DeepSWE" are not the same run of the same test. A
/// patch number says nothing a person compares, so major.minor stays.
function withVersion(text: string, name: string): string {
  const match = /\bv?(\d+\.\d+)(?:\.\d+)?\b|\bv(\d+)\b/i.exec(text);
  const version = match?.[1] ?? match?.[2];
  return version ? `${name} ${version}` : name;
}

/// The benchmark a rating measures. The first matching rule names the
/// family; a version inside the name stays part of it, because
/// Terminal-Bench 2.1 and 4.0 are different tests.
const FAMILIES: [RegExp, string | ((match: RegExpMatchArray, whole: string) => string)][] = [
  [/intelligen(ce|t)\s*index/i, "Intelligence Index"],
  [/coding\s*(?:agent\s*)?index/i, "Coding Index"],
  [/agentic\s*index/i, "Agentic Index"],
  [/gpqa/i, "GPQA Diamond"],
  [/swe-?\s?bench[^a-z0-9]{0,3}verified/i, "SWE-bench Verified"],
  [/swe-?\s?bench[^a-z0-9]{0,3}multilingual/i, "SWE-bench Multilingual"],
  [/swe-?\s?bench[^a-z0-9]{0,3}pro/i, "SWE-bench Pro"],
  [/swe-?\s?bench[^a-z0-9]{0,3}lite/i, "SWE-bench Lite"],
  [/swe-?\s?bench/i, "SWE-bench"],
  [
    /terminal[-\s]?bench(?:ing)?[^a-z0-9]{0,6}(v?\d+\.\d+)?/i,
    (match) => (match[1] ? `Terminal-Bench ${match[1].replace(/^v/i, "")}` : "Terminal-Bench"),
  ],
  [/deep\s?swe/i, (_match, whole) => withVersion(whole, "DeepSWE")],
  [/live\s*code\s*bench/i, "LiveCodeBench"],
  [/\baime\b/i, "AIME"],
  [/\bhle\b|humanity'?s last exam/i, "HLE"],
  [/mmlu[-\s]?pro/i, "MMLU-Pro"],
  [/\bmmlu\b/i, "MMLU"],
  [/τ\s?2|tau\s?2|τ²/i, "τ²-Bench"],
  [/tau[-\s]?bench|τ[-\s]?bench/i, "τ-Bench"],
  [/webdev\s*elo|webdev arena/i, "WebDev Arena Elo"],
  [/design arena|image\s*elo/i, "Design Arena Elo"],
  [/briefcase/i, "AA-Briefcase"],
  [/lmarena|lm arena|chatbot arena|arena[-\s]hard|text arena|vision arena/i, "LMArena Elo"],
  [/\belo\b/i, "Elo"],
  [/tok\w*\s*\/\s*s\b|tokens?\s+per\s+second|output\s+speed|tokens?\s*\/\s*sec|throughput/i, "Output speed"],
  [/latency|first[-\s]token|\bttft\b|time\s+to\s+first/i, "Latency"],
  [/browse\s?comp/i, "BrowseComp"],
  [/osworld[-\s]?verified/i, "OSWorld-Verified"],
  [/osworld/i, (_match, whole) => withVersion(whole, "OSWorld")],
  [/mmmu/i, (match) => (/pro/i.test(match[0]) ? "MMMU-Pro" : "MMMU")],
  [/ifbench/i, "IFBench"],
  [/sci\s?code/i, "SciCode"],
  [/gsm8k/i, "GSM8K"],
  [/bfcl/i, (_match, whole) => withVersion(whole, "BFCL")],
  [/\bmgsm\b/i, "MGSM"],
  [/automation\s?bench/i, "AutomationBench"],
  [/livebench\s*coding/i, "LiveBench Coding"],
  [/livebench\s*reasoning/i, "LiveBench Reasoning"],
  [/nl2repo/i, "NL2Repo"],
  [/program\s?bench/i, "ProgramBench"],
  [/gdpval/i, "GDPval"],
  [/exploit\s?bench/i, "ExploitBench"],
  [/multi\s?challenge/i, "MultiChallenge"],
  [/mt-?bench/i, "MM MTBench"],
  [/ocrbench/i, "OCRBench"],
  [/\bmmvu\b/i, "MMVU"],
  [/math[-\s]?500/i, "Math-500"],
  [/ifeval/i, "IFEval"],
  [/human[-\s]?eval/i, "HumanEval"],
  [/\bmbpp\b/i, "MBPP"],
  [/arc[-\s]?agi/i, "ARC-AGI"],
  [/cyber\s?gym/i, "CyberGym"],
  [/swe-?\s?lancer/i, "SWE-Lancer"],
];

function cleanMetric(metric: string): string {
  return metric
    .replace(/\s*\(\s*%\s*\)/g, "")
    .replace(/\s*\(percent\)/gi, "")
    .replace(/%/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/// A composite index changes its scale between major versions: 68 on
/// Intelligence Index v4 is not more than 62 on v5. For each index, when
/// the newest major version was first seen. Computed once per catalog.
export type IndexEras = Record<string, { latest: string; since: string }>;

const INDEX = /(?:intelligence|coding|agentic)\s*index/i;
// "v5", "v5.0.1" and "5.0.1": the major version of an index.
const MAJOR = /\bv?(\d+)(?:\.\d+)+\b|\bv(\d+)\b/i;
const majorOf = (text: string) => {
  const match = MAJOR.exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
};
// The same, read from a note that may hold other numbers too.
const INDEX_VERSION = /(?:intelligence|coding|agentic)\s*index\s*v?(\d+)(?:\.\d+)*/i;

/// When each composite index moved to its newest major version, read from
/// every card that states a version. Undated versioned cards put the
/// switch at the beginning, so undated ones count as current.
export function indexEras(cards: { ratings?: KnowledgeRating[] | null }[]): IndexEras {
  const first: Record<string, Record<string, string>> = {};
  for (const card of cards)
    for (const rating of card.ratings ?? []) {
      const index = INDEX.exec(rating.metric ?? "");
      const major = majorOf(rating.metric ?? "");
      if (!index || !major) continue;
      const base = index[0].toLowerCase().replace(/\s+/g, " ");
      const seen = rating.as_of ?? "";
      const byVersion = (first[base] ??= {});
      if (!byVersion[major] || seen < byVersion[major]) byVersion[major] = seen;
    }
  const eras: IndexEras = {};
  for (const [base, byVersion] of Object.entries(first)) {
    const latest = Object.keys(byVersion).sort((a, b) => Number(b) - Number(a))[0];
    eras[base] = { latest, since: byVersion[latest] };
  }
  return eras;
}

// The lab that publishes a composite index is the only one whose numbers
// are known to be on its scale. A community site's "Intelligence Index"
// may be a benchmark of its own; a vendor's is a quotation.
const INDEX_OWNER = /artificial analysis|anlys|(?<![a-z])aa(?![a-z])|openrouter|vals ai/i;

// The eras of the catalog that is open, set by the page that reads it, so
// a dossier and a hover card name a benchmark exactly as the directory does.
let openEras: IndexEras = {};
export function setIndexEras(eras: IndexEras) {
  openEras = eras;
}

/// The benchmark from one rating, in a form models can be compared by.
export function benchmarkOf(
  rating: KnowledgeRating,
  vendor?: string | null,
  eras: IndexEras = openEras,
): Benchmark {
  const source = (rating.source ?? "").replace(/\s+/g, " ").trim();
  let name = cleanMetric(rating.metric ?? "");
  // "(Low, default fallback)" or a trailing "without tools": the same
  // benchmark under other conditions.
  const note = /\(([^()]*)\)/.exec(name)?.[1]?.trim();
  let variant = note && !/^[%\s]+$/.test(note) ? qualifierLabel(note) : null;
  if (note) name = name.replace(/\([^()]*\)/, "").trim();
  const qualifier = name.search(QUALIFIER);
  if (!variant && qualifier > 0) {
    variant = qualifierLabel(QUALIFIER.exec(name)![0]);
    name = name.slice(0, qualifier).replace(/[\s,;-]+$/, "");
  }
  // Newer cards put the conditions in the note: "max reasoning effort".
  if (!variant && rating.note) {
    const effort = EFFORT_NOTE.exec(rating.note)?.slice(1).find(Boolean);
    if (effort) variant = `${effort.toLowerCase()} effort`;
  }
  const rule = FAMILIES.find(([pattern]) => pattern.test(name));
  const hit = rule && rule[0].exec(name);
  const family = hit
    ? typeof rule[1] === "function"
      ? rule[1](hit, name)
      : rule[1]
    : name;
  // A composite index is compared within one major version, and only on
  // its publisher's scale.
  const index = INDEX.exec(family);
  // The version is in what the card wrote, not in the family's own name.
  // Newer cards put it in the note: "Artificial Analysis Intelligence
  // Index v5.0".
  const major =
    majorOf(name) ?? (index && rating.note ? INDEX_VERSION.exec(rating.note)?.[1] : undefined);
  let label = family;
  // "τ²-Bench" ids as "tau2-bench": ids travel in URLs and code.
  let id = family
    .toLowerCase()
    .replace(/τ²/g, "tau2")
    .replace(/τ/g, "tau")
    .replace(/[^a-z0-9.-]+/g, " ")
    .trim();
  // "Overall score" means one thing on one site and another on the next,
  // so such names only compare models scored by the same source.
  if (!hit && GENERIC.test(family)) id = `${sourceLabel(source).toLowerCase()} ${id}`.trim();
  if (index) {
    const base = index[0].toLowerCase().replace(/\s+/g, " ");
    const era = eras?.[base];
    const version =
      major ?? (!era || (rating.as_of ?? "") >= era.since ? era?.latest : undefined);
    if (version) {
      label = `${capitalise(base)} v${version}`;
      id = `${base} v${version}`;
    } else if (era) {
      label = `${capitalise(base)} (before v${era.latest})`;
      id = `${base} before v${era.latest}`;
    } else {
      label = capitalise(base);
      id = base;
    }
    // A vendor that writes "Intelligence Index" is quoting the publisher's
    // number. A community site may run an index of its own on its own scale.
    if (sourceKind(source, vendor) === "community" && !INDEX_OWNER.test(source))
      id = `${id} · ${source.toLowerCase()}`;
  }
  const kind = sourceKind(source, vendor);
  return {
    id,
    label: label || "Score",
    variant,
    kind,
    source: sourceLabel(source),
  };
}

function capitalise(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/// Who measured: a lab publishes numbers for every model, a vendor only
/// its own. Vendor numbers are kept apart, they are not silently compared.
export function sourceKind(source: string, vendor?: string | null): Benchmark["kind"] {
  const text = source.toLowerCase();
  const own = vendor ? VENDORS.find(([pattern]) => pattern.test(vendor.toLowerCase()))?.[0] : null;
  if (own?.test(text) || VENDOR_PUBLICATION.test(source)) return "vendor";
  if (LABS.some(([pattern]) => pattern.test(text))) return "lab";
  return VENDOR_NEWS.test(source) ? "vendor" : "community";
}

function sourceLabel(source: string): string {
  const text = source.toLowerCase();
  return LABS.find(([pattern]) => pattern.test(text))?.[1] ?? source;
}

export type Score = { rating: KnowledgeRating; benchmark: Benchmark };

const INDEPENDENCE: Record<Benchmark["kind"], number> = { lab: 0, community: 1, vendor: 2 };

/// One score per benchmark family: the default variant from the most
/// independent source, i.e. the number a person would look up first.
export function scoresOf(
  ratings: KnowledgeRating[] | null | undefined,
  vendor?: string | null,
  eras: IndexEras = openEras,
): Map<string, Score> {
  const best = new Map<string, Score>();
  for (const rating of ratings ?? []) {
    if (!Number.isFinite(rating.value) || !rating.metric?.trim() || rating.metric === "value") continue;
    const score: Score = { rating, benchmark: benchmarkOf(rating, vendor, eras) };
    const current = best.get(score.benchmark.id);
    if (!current || moreComparable(score, current)) best.set(score.benchmark.id, score);
  }
  return best;
}

/// Whether `next` is the number to show in place of `current`: the reading
/// without a setting, from the most independent source, at the lowest effort.
export function moreComparable(next: Score, current: Score): boolean {
  const variant = Number(next.benchmark.variant !== null) - Number(current.benchmark.variant !== null);
  if (variant) return variant < 0;
  const source = INDEPENDENCE[next.benchmark.kind] - INDEPENDENCE[current.benchmark.kind];
  if (source) return source < 0;
  // The same kind of source, both naming an effort: the lower one is nearer
  // to how the model answers by default, which is what a ranking compares.
  if (next.benchmark.variant && current.benchmark.variant) {
    const a = effortRank(next.benchmark.variant);
    const b = effortRank(current.benchmark.variant);
    if (a !== undefined && b !== undefined && a !== b) return a < b;
  }
  return (next.rating.as_of ?? "") > (current.rating.as_of ?? "");
}

/// What else the card measured on each benchmark `scoresOf` shows: the same
/// test at another effort, or the vendor's own figure beside the lab's.
/// Keyed by benchmark id, best first. A reading that differs from the shown
/// one in neither way is left out.
export function otherScoresOf(
  ratings: KnowledgeRating[] | null | undefined,
  vendor?: string | null,
  eras: IndexEras = openEras,
): Map<string, Score[]> {
  const shown = scoresOf(ratings, vendor, eras);
  const rest = new Map<string, Score[]>();
  for (const rating of ratings ?? []) {
    if (!Number.isFinite(rating.value) || !rating.metric?.trim() || rating.metric === "value") continue;
    const score: Score = { rating, benchmark: benchmarkOf(rating, vendor, eras) };
    const main = shown.get(score.benchmark.id);
    // Not on a benchmark the dossier lists, or the listed reading itself.
    if (!main || main.rating === rating) continue;
    const { variant, kind } = score.benchmark;
    if (variant === main.benchmark.variant && kind === main.benchmark.kind) continue;
    const list = rest.get(score.benchmark.id);
    if (list) list.push(score);
    else rest.set(score.benchmark.id, [score]);
  }
  for (const list of rest.values()) list.sort((a, b) => b.rating.value - a.rating.value);
  return rest;
}

const SITE_SECTION =
  /^(www|docs?|doc|platform|developer|developers|build|blog|news|support|help|api|api-docs|learn|community|console|cloud|catalog|integrate|dev|eu)$/;

/// Source domain as a short label: "platform.claude.com" reads "claude.com".
export function sourceHost(raw: string): string {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/:\d+$/, "");
  } catch {
    return raw;
  }
  const parts = host.split(".");
  // Two labels are the site itself; a leading section is dropped.
  while (parts.length > 2 && SITE_SECTION.test(parts[0])) parts.shift();
  return parts.join(".");
}
