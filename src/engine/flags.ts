// The guard's flag log: <git-dir>/beacon/flags.jsonl, one JSON object per
// out-of-scope write. The guard appends (flagLine, bundled into it); the
// engine reads.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlagEvent } from "./types.ts";

export const FLAG_LOG = "flags.jsonl";

export interface FlagRecord extends FlagEvent {
  branch: string;
}

export function flagLine({ ts, branch, file, tool, reason }: FlagRecord): string {
  return JSON.stringify({ ts, branch, file, tool, reason }) + "\n";
}

// Every event the guard logged for a branch, oldest first.
export async function readFlagEvents(dir: string, branch: string): Promise<FlagEvent[]> {
  const events: FlagEvent[] = [];
  let text: string;
  try { text = await readFile(join(dir, FLAG_LOG), "utf8"); } catch { return events; }
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const f = JSON.parse(line);
      if (f.branch === branch && f.file) events.push({ ts: f.ts, file: f.file, tool: f.tool || "", reason: f.reason || "" });
    } catch { /* skip malformed lines */ }
  }
  return events;
}

// Newest flag per file (for annotating the flagged-file list).
export async function readFlags(dir: string, branch: string): Promise<Map<string, Omit<FlagEvent, "file">>> {
  const byFile = new Map<string, Omit<FlagEvent, "file">>();
  for (const f of await readFlagEvents(dir, branch)) byFile.set(f.file, { ts: f.ts, tool: f.tool, reason: f.reason });
  return byFile;
}
