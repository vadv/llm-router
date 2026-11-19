import { useEffect, useState } from "react";
import { api, type ModelSummary } from "./api";

// The catalog polls independently. Read summaries again only when its keys change or after collection.
export function useModelSummaries(keyList: string | null) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    keys: string;
    cards?: ModelSummary[];
    error?: string;
  }>();
  useEffect(() => {
    if (keyList === null) return;
    const controller = new AbortController();
    const read = async () => {
      const keys: string[] = JSON.parse(keyList),
        cards: ModelSummary[] = [];
      for (let start = 0; start < keys.length; start += 128) {
        if (controller.signal.aborted) return;
        cards.push(
          ...(await api.modelSummaries(
            keys.slice(start, start + 128),
            controller.signal,
          )),
        );
      }
      if (!controller.signal.aborted) setState({ keys: keyList, cards });
    };
    read().catch((e) => {
      if (!controller.signal.aborted)
        setState({
          keys: keyList,
          error: e instanceof Error ? e.message : String(e),
        });
    });
    return () => controller.abort();
  }, [keyList, revision]);
  return {
    state: state?.keys === keyList ? state : undefined,
    reload: () => setRevision((v) => v + 1),
  };
}
