// What a benchmark measures and how to read its number. A score means
// little without the test behind it, so the Wiki explains each one where it
// is shown. Keys are the family ids the card normalizer produces; a
// versioned id such as "terminal-bench 4.0" falls back to its family.

export type BenchmarkInfo = {
  /// What the model is asked to do, in one sentence.
  what: string;
  /// The unit and the direction, as a person reads the column.
  scale: string;
  /// Most scores rise with quality. A few fall.
  lowerIsBetter?: boolean;
};

const KNOWN: Record<string, BenchmarkInfo> = {
  "intelligence index": {
    what: "Artificial Analysis's composite of reasoning, coding, math and knowledge tests: a general quality score.",
    scale: "Index points, higher is better",
  },
  "coding index": {
    what: "Artificial Analysis's composite of coding and software-engineering tests.",
    scale: "Index points, higher is better",
  },
  "agentic index": {
    what: "Artificial Analysis's composite of tool-use and agent tasks.",
    scale: "Index points, higher is better",
  },
  "aa-lcr": {
    what: "Artificial Analysis's long-context reading test.",
    scale: "% correct",
  },
  "aa-briefcase": {
    what: "Artificial Analysis's benchmark of business deliverables: documents, slides, spreadsheets.",
    scale: "% correct",
  },
  "gpqa diamond": {
    what: "Graduate-level science questions that PhD experts answer at about 70% and skilled non-experts, web search in hand, at about a third.",
    scale: "% correct",
  },
  "swe-bench verified": {
    what: "Real GitHub issues from Python repositories; the model ships a patch that must pass the project's tests.",
    scale: "% resolved",
  },
  "swe-bench pro": {
    what: "SWE-bench on larger, enterprise-style repositories in several languages.",
    scale: "% resolved",
  },
  "swe-bench multilingual": {
    what: "SWE-bench outside Python, across nine languages.",
    scale: "% resolved",
  },
  "swe-bench lite": {
    what: "A 300-task subset of SWE-bench.",
    scale: "% resolved",
  },
  "swe-bench": {
    what: "Real GitHub issues; the model ships a patch that must pass the project's tests.",
    scale: "% resolved",
  },
  "terminal-bench": {
    what: "Tasks done in a real shell: build, debug, configure, run. Versions differ in difficulty, so compare within one version.",
    scale: "% solved",
  },
  "deepswe": {
    what: "Long software-engineering tasks on real repositories, scored with tests and review.",
    scale: "% solved",
  },
  "livecodebench": {
    what: "Competitive-programming problems published after a model's training cutoff, so it cannot have memorized them.",
    scale: "% pass@1",
  },
  aime: {
    what: "The American Invitational Mathematics Examination: competition mathematics.",
    scale: "% correct",
  },
  hle: {
    what: "Humanity's Last Exam: expert-written questions at the edge of human knowledge.",
    scale: "% correct",
  },
  "mmlu-pro": {
    what: "Multiple-choice knowledge and reasoning in 14 subjects, with ten options to cut guessing.",
    scale: "% correct",
  },
  "mmlu": {
    what: "A multiple-choice knowledge test across 57 school and professional subjects.",
    scale: "% correct",
  },
  mmmu: {
    what: "College-level multiple-choice questions that need charts, diagrams and figures read from images.",
    scale: "% correct",
  },
  "tau-bench": {
    what: "A tool-using agent serves a simulated customer in retail or airline booking. Success needs the right outcome and the right policy.",
    scale: "% success",
  },
  "tau2-bench": {
    what: "τ-bench with a user who pushes back, and telecom scenarios.",
    scale: "% success",
  },
  "lmarena elo": {
    what: "LMArena (Chatbot Arena): blind side-by-side votes by people. The rating says who won more often.",
    scale: "Elo, higher is better",
  },
  "webdev arena elo": {
    what: "LMArena's WebDev Arena: people vote between two generated web apps.",
    scale: "Elo, higher is better",
  },
  "design arena elo": {
    what: "Design Arena: votes between two generated designs.",
    scale: "Elo, higher is better",
  },
  elo: {
    what: "A rating from pairwise votes.",
    scale: "Elo, higher is better",
  },
  "output speed": {
    what: "Tokens the model generates per second once it has started.",
    scale: "tok/s, higher is better",
  },
  latency: {
    what: "Time until the first token arrives.",
    scale: "seconds, lower is better",
    lowerIsBetter: true,
  },
  browsecomp: {
    what: "OpenAI's benchmark of multi-step web research questions that are hard to find.",
    scale: "% correct",
  },
  osworld: {
    what: "Real tasks on a desktop computer: files, settings, browser, office apps.",
    scale: "% completed",
  },
  ifbench: {
    what: "Instruction following: prompts with strict, checkable output constraints.",
    scale: "% followed",
  },
  ifeval: {
    what: "Instruction following: prompts with strict formatting rules, checked automatically.",
    scale: "% followed",
  },
  scicode: {
    what: "Scientific computing problems solved with code and tested against reference results.",
    scale: "% solved",
  },
  gsm8k: {
    what: "Grade-school word problems in arithmetic.",
    scale: "% correct",
  },
  bfcl: {
    what: "Berkeley Function Calling: choosing the right function and filling its arguments.",
    scale: "% accuracy",
  },
  "math-500": {
    what: "A 500-problem slice of the MATH competition set.",
    scale: "% correct",
  },
  humaneval: {
    what: "Write a function from its docstring; checked by unit tests.",
    scale: "% pass@1",
  },
  "arc-agi": {
    what: "Abstraction-and-reasoning grid puzzles built to be easy for people and hard for models.",
    scale: "% solved",
  },
  cybergym: {
    what: "Finding and exploiting real software vulnerabilities in reproducible environments.",
    scale: "% solved",
  },
  "swe-lancer": {
    what: "Paid, real freelance software tasks from Upwork, with manager-reviewed outcomes.",
    scale: "% completed",
  },
};

// The longest key wins, so "swe-bench verified" is not read as "swe-bench".
const BY_LENGTH = Object.keys(KNOWN).sort((a, b) => b.length - a.length);
// Families without an entry of their own, read by their name.
const LOWER_IS_BETTER = /hallucination|error rate|latency|time to first/i;

/// Where a family sits among the known ones: the order they are introduced
/// in above, unknown families last. Dossiers list the familiar first.
export function benchmarkOrder(id: string): number {
  const plain = id.replace(/ (?:v\d+|before v\d+)$/, "").split(" · ")[0];
  const hit = BY_LENGTH.find(
    (key) => plain === key || plain.startsWith(`${key} `) || plain.startsWith(`${key}-`),
  );
  return hit ? Object.keys(KNOWN).indexOf(hit) : KNOWN_ORDER.length;
}
const KNOWN_ORDER = Object.keys(KNOWN);

/// What is known about a benchmark family, or how to read an unknown one.
export function benchmarkInfo(id: string): BenchmarkInfo {
  // A versioned index ("intelligence index v5") reads as its index.
  const plain = id.replace(/ (?:v\d+|before v\d+)$/, "").split(" · ")[0];
  const hit = BY_LENGTH.find(
    (key) => plain === key || plain.startsWith(`${key} `) || plain.startsWith(`${key}-`),
  );
  if (hit) return KNOWN[hit];
  const lower = LOWER_IS_BETTER.test(id);
  return { what: "", scale: lower ? "Lower is better" : "Higher is better", lowerIsBetter: lower };
}

/// Whether a lower number is the better one for this benchmark.
export function lowerIsBetter(id: string): boolean {
  return benchmarkInfo(id).lowerIsBetter === true;
}
