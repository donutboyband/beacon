// Shapes shared across the engine and returned to the app and CLI.

// Where a changed file sits relative to the branch's declared scope.
export type Zone = "prototype" | "beacon" | "in" | "out";

export interface ScopeConfig {
  allow: string[];
  deny: string[];
  prototype: string[];
}

export interface ChangedFile {
  file: string;
  status: string;
  outOfScope: boolean;
  prototype: boolean;
}

// What the added lines of a diff reuse or assume — drives the PR description.
export interface Signal {
  tokens: string[];
  components: string[];
  assumptions: string[];
}

export interface Annotation {
  title: string;
  body: string;
  source: string;
}

// One out-of-scope write as the guard logged it.
export interface FlagEvent {
  ts: string;
  file: string;
  tool: string;
  reason: string;
}

export interface StatusResult {
  branch: string;
  defaultBranch: string;
  files: ChangedFile[];
  signal: Signal;
  stat: string;
}
