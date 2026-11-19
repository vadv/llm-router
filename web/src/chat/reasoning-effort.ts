// Auto leaves the provider's default unchanged; it is not an API value.
export type ReasoningEffort = "auto" | "low" | "medium" | "high";

export function readReasoningEffort(value: unknown): ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" ? value : "auto";
}
