// Title bar: repository → branch (two linked dropdowns), the GitHub chip, and
// Fetch / Pull.

import { branchMenu, call, connectGh, ghMenu, openRepo, recheckGh, refreshView, toast } from "../actions.ts";
import { useStore } from "../store.ts";
import { BusyButton, Icon, Spinner } from "./common.tsx";

function GhChip() {
  const s = useStore();
  if (!s.ghShown) return <button className="gh-chip" id="gh-status"></button>;
  if (s.ghPending) {
    return (
      <button className="gh-chip action" id="gh-status" title={s.ghPending.title} onClick={() => recheckGh()}>
        <Spinner /><span>{s.ghPending.label}</span>
      </button>
    );
  }
  const g = s.gh;
  if (!g.installed) {
    return (
      <button className="gh-chip warn" id="gh-status" title="Install the GitHub CLI (gh) to open pull requests" onClick={() => window.beacon.openExternal("https://cli.github.com")}>
        <Icon name="x-circle" /><span>GitHub CLI not found</span>
      </button>
    );
  }
  if (!g.authed) {
    return (
      <button className="gh-chip action" id="gh-status" title="Sign in to GitHub to open pull requests" onClick={() => connectGh()}>
        <Icon name="pull-request" /><span>Connect GitHub</span>
      </button>
    );
  }
  return (
    <button className="gh-chip ok" id="gh-status" title={`Connected to GitHub${g.login ? " as @" + g.login : ""}`} onClick={ghMenu}>
      <Icon name="check" /><span>{g.login ? "@" + g.login : "GitHub"}</span><Icon name="caret-up-down" cls="gh-caret" />
    </button>
  );
}

export function TopNav() {
  const { ctx, cwd } = useStore();
  const has = !!(ctx && ctx.isRepo);
  const onDefault = has && ctx!.branch === ctx!.defaultBranch;
  return (
    <header className="titlebar">
      <nav className="topnav">
        {/* Two linked dropdowns: repository → branch (breadcrumb-style) */}
        <div className="navsel" id="navsel">
          <button className="navsel-part" id="repo-btn" title="Open a repository…" onClick={() => openRepo()}>
            <Icon name="folder" />
            <span className="navsel-label" id="repo-name">{has ? (ctx!.ownerRepo || ctx!.cwd!.split("/").pop()) : "Open a repository…"}</span>
          </button>
          <span className="navsel-sep" aria-hidden="true">/</span>
          <button className={`navsel-part${has ? "" : " hidden"}`} id="branch-btn" onClick={branchMenu}>
            <Icon name="branch" />
            <span className="navsel-label" id="branch-name">{has && !onDefault ? ctx!.branch : "Working tree"}</span>
            <Icon name="caret-up-down" cls="navsel-caret" />
          </button>
        </div>
        <div className="nav-right">
          {/* GitHub connection status / onboarding */}
          <GhChip />
          <BusyButton className="btn small" id="fetch-btn" title="Get the latest from GitHub" disabled={!has} busyLabel="Fetching" restore
            onRun={async () => {
              if (!cwd) return;
              await call(window.beacon.fetchRemote(cwd));
              toast("Fetched the latest from GitHub");
              await refreshView();
            }}>Fetch</BusyButton>
          <BusyButton className="btn small" id="pull-btn" title="Bring the latest into this branch" disabled={!has} busyLabel="Pulling" restore
            onRun={async () => {
              if (!cwd) return;
              const r = await call(window.beacon.pull(cwd));
              toast(r.note && /already up to date/i.test(r.note) ? "Already up to date" : "Pulled the latest changes");
              await refreshView();
            }}>Pull</BusyButton>
        </div>
      </nav>
    </header>
  );
}
