// Branch scope (.beacon/scope.json) — shared by the engine and the guard, so
// the live flag and the pre-PR review always agree on what's in scope.
//
// The scope is an ALLOWLIST: on a Beacon-started branch, the agent (or anyone)
// may edit files matching `allow` (the front end — styles, components, pages,
// assets, tokens, …) and may create new files there. `deny` ALWAYS WINS, so
// backend/auth/routing/DB/config stay protected even when they'd otherwise
// match the allowlist (e.g. a `routes/` folder full of .tsx). A file is in
// scope iff it matches `allow` AND not `deny`; everything else is out of scope.
//
// The scope is written per branch, committed as the branch's FIRST commit
// (together with a plain-language CLAUDE.md section) so the declaration is
// visible in the PR diff before any change is.
//
// PROTOTYPE ZONE: when the task needs backend behaviour to work, the agent is
// told (CLAUDE.md) not to build it — instead it mocks the data/service layer
// under the `prototype` paths and renders the real components against fixtures
// there. Prototype files are always in scope, tracked as their own category,
// and the backend work needed (`.beacon/prototype/README.md`) rides into the
// PR description for the developer who productionizes it.
//
// Dependency-free beyond Node built-ins: this module is bundled into the guard.

import type { ScopeConfig, Zone } from "./types.ts";

export const SCOPE_FILE = ".beacon/scope.json";
export const PROTO_NOTES = ".beacon/prototype/README.md";

// Where a working prototype may mock what the backend would provide.
export const DEFAULT_PROTOTYPE = [".beacon/prototype/**"];

// The front end: what a Beacon-scoped branch can freely edit and add to.
export const DEFAULT_ALLOW = [
  "**/*.css", "**/*.scss", "**/*.sass", "**/*.less", "**/*.pcss", "**/*.styl",
  "**/*.svg", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.avif", "**/*.ico",
  "**/*.woff", "**/*.woff2", "**/*.ttf", "**/*.otf",
  "**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.mdx",
  "**/*.html", "**/*.md",
  "**/components/**", "**/component/**",
  "**/pages/**", "**/views/**", "**/screens/**", "**/layouts/**", "**/layout/**",
  "**/styles/**", "**/styling/**", "**/theme/**", "**/themes/**",
  "**/design-tokens/**", "**/tokens/**", "**/*.tokens.json",
  "**/assets/**", "**/public/**", "**/static/**", "**/images/**", "**/img/**", "**/fonts/**", "**/icons/**",
  "apps/web-client/**", "apps/web-customer-client/**",
  "packages/design-tokens/**",
  // Front-end build & styling config (Tailwind, PostCSS, Vite, tsconfig), at the
  // repo root or nested. Backend configs stay denied — their directory
  // (apps/web-server, …) wins on the denylist below.
  "*.config.js", "*.config.cjs", "*.config.mjs", "*.config.ts", "tsconfig*.json",
  "**/*.config.js", "**/*.config.cjs", "**/*.config.mjs", "**/*.config.ts", "**/tsconfig*.json",
];

// Never in scope, even if matched above. Denylist wins.
export const DEFAULT_DENY = [
  "**/auth/**", "**/*auth*",
  "**/middleware*", "**/*middleware*",
  "**/routes/**", "**/routing/**", "**/*router*", "**/*routes-registry*", "**/route.*", "**/*.route.*",
  "**/api/**",
  "**/server/**", "apps/web-server/**", "apps/worker/**",
  "supabase/**", "**/migrations/**", "**/*.sql",
  "**/db/**", "**/database/**", "**/prisma/**", "**/*schema*",
  "**/.env*", "**/*.env*", "**/fnox.toml",
  ".github/**", "**/.github/**",
  "package.json", "**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock",
];

export const DEFAULT_SCOPE: ScopeConfig = { allow: DEFAULT_ALLOW, deny: DEFAULT_DENY, prototype: DEFAULT_PROTOTYPE };

// Take each list from a parsed scope.json only if it's an array; otherwise
// keep the fallback's.
export function scopeFrom(raw: any, fallback: ScopeConfig): ScopeConfig {
  return {
    allow: Array.isArray(raw?.allow) ? raw.allow : fallback.allow,
    deny: Array.isArray(raw?.deny) ? raw.deny : fallback.deny,
    prototype: Array.isArray(raw?.prototype) ? raw.prototype : fallback.prototype,
  };
}

// `**` crosses directories, `*` stays within one; everything else is literal.
const compiled = new Map<string, RegExp>();
export function globToRegex(glob: string): RegExp {
  let re = compiled.get(glob);
  if (!re) {
    const body = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\0/g, ".*");
    re = new RegExp(`^${body}$`);
    compiled.set(glob, re);
  }
  return re;
}

export function firstMatch(file: string, globs: string[]): string | undefined {
  return globs.find((g) => globToRegex(g).test(file));
}

export const matchesAny = (file: string, globs: string[]) => firstMatch(file, globs) !== undefined;

// Classify by the globs alone: the prototype zone, or in/out of scope.
export function matchZone(file: string, cfg: ScopeConfig): "prototype" | "in" | "out" {
  if (matchesAny(file, cfg.prototype)) return "prototype";
  return matchesAny(file, cfg.allow) && !matchesAny(file, cfg.deny) ? "in" : "out";
}

export const isBeaconFile = (file: string) => file === "CLAUDE.md" || file === ".beacon" || file.startsWith(".beacon/");

// Classify a file: "prototype" (the mock zone — always in scope, tracked as
// its own category), "beacon" (Beacon's own declaration files), "in" (matches
// allow and not deny), or "out" (everything else — flagged).
export function fileZone(file: string, cfg: ScopeConfig): Zone {
  const zone = matchZone(file, cfg);
  return zone !== "prototype" && isBeaconFile(file) ? "beacon" : zone;
}

export const isOutOfScope = (file: string, cfg: ScopeConfig) => fileZone(file, cfg) === "out";

// Why a file is out of scope — same wording whether the guard saw the write
// or the diff scan found it.
export function scopeReason(file: string, cfg: ScopeConfig): string {
  const denied = firstMatch(file, cfg.deny);
  if (denied) return `it matches the denied pattern "${denied}" — backend, auth, routing, DB, and infra are off-limits on this branch`;
  return "it doesn't match any allowed front-end pattern for this branch";
}
