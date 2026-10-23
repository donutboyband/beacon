// The guard's flag log: <git-dir>/beacon/flags.jsonl, one JSON object per
// out-of-scope write. The guard appends; review reads. Bundled into the guard.

import { existsSync, readFileSync } from "node:fs";
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
export function readFlagEvents(dir: string, branch: string): FlagEvent[] {
  const path = join(dir, FLAG_LOG);
  const events: FlagEvent[] = [];
  if (!existsSync(path)) return events;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const f = JSON.parse(line);
      if (f.branch === branch && f.file) events.push({ ts: f.ts, file: f.file, tool: f.tool || "", reason: f.reason || "" });
    } catch { /* skip malformed lines */ }
  }
  return events;
}

// Newest flag per file (for annotating the flagged-file list).
export function readFlags(dir: string, branch: string): Map<string, Omit<FlagEvent, "file">> {
  const byFile = new Map<string, Omit<FlagEvent, "file">>();
  for (const f of readFlagEvents(dir, branch)) byFile.set(f.file, { ts: f.ts, tool: f.tool, reason: f.reason });
  return byFile;
}
