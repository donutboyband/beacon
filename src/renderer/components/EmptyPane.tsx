// The default right pane, which doubles as the first-run funnel:
//   1. Connect GitHub (before we ever show "select a repo")
//   2. Select a repository
//   3. Pull latest (only if the branch is behind) → then Create a branch

import { useEffect, useRef } from "react";
import { call, connectGh, openRepo, reloadRepoState, selectWorking, showEmpty, startBranch, toast } from "../actions.ts";
import { isDirty, set, useStore } from "../store.ts";
import { BusyButton, Icon } from "./common.tsx";

// A three-step onboarding progress bar (Connect GitHub → Select repo → New branch).
function OnboardSteps({ active }: { active: number }) {
  const steps = ["Connect GitHub", "Select repository", "New branch"];
  return (
    <div className="onboard-steps">
      {steps.map((s, i) => [
        i > 0 ? <span key={`sep${i}`} className="ob-sep">›</span> : null,
        <span key={s} className={`ob-step ${i < active ? "done" : i === active ? "active" : ""}`}>{i < active ? <Icon name="check" cls="ob-check" /> : null}{s}</span>,
      ])}
    </div>
  );
}

function ConnectStep({ installed }: { installed: boolean }) {
  return (
    <>
      <div className="empty-illus"><Icon name="pull-request" /></div>
      <h2>{installed ? "Connect your GitHub account" : "Install the GitHub CLI"}</h2>
      <p className="empty-msg">{installed
        ? "Sign in once so Beacon can open pull requests for you. Beacon stores nothing — your GitHub CLI handles the sign-in."
        : "Beacon uses the GitHub CLI (gh) to open pull requests. Install it from cli.github.com, then connect."}</p>
      <button className="btn signal" id="ob-gh" onClick={() => (installed ? connectGh() : window.beacon.openExternal("https://cli.github.com"))}>
        {installed ? "Connect GitHub" : "Get the GitHub CLI"}
      </button>
      <OnboardSteps active={0} />
    </>
  );
}

function SelectRepoStep() {
  return (
    <>
      <div className="empty-illus"><Icon name="folder" /></div>
      <h2>Select a repository</h2>
      <p className="empty-msg">Choose a folder on your machine to start working.</p>
      <button className="btn primary" id="ob-repo" onClick={() => openRepo()}><Icon name="folder" /> Select a repository</button>
      <OnboardSteps active={1} />
    </>
  );
}

function UpdateStep() {
  const { ctx, sync, cwd } = useStore();
  return (
    <>
      <div className="empty-illus"><Icon name="pull" /></div>
      <h2>Get up to date first</h2>
      <p className="empty-msg">{`${ctx!.branch} is ${sync.behind} commit${sync.behind > 1 ? "s" : ""} behind ${sync.upstream || "origin"}. Pull the latest before starting a new branch.`}</p>
      <div className="create-row" style={{ justifyContent: "center" }}>
        <BusyButton className="btn signal" id="ob-pull" busyLabel="Pulling"
          onRun={async () => { await call(window.beacon.pull(cwd!)); toast("Pulled the latest changes"); await reloadRepoState(); showEmpty(); }}>
          Pull latest changes
        </BusyButton>
        <button className="btn" id="ob-skip" onClick={() => { set({ skipSync: true }); showEmpty(); }}>Skip</button>
      </div>
    </>
  );
}

function CreateStep() {
  const { ctx, working } = useStore();
  const dirty = isDirty();
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => { name.current?.focus(); }, []);
  const go = () => startBranch(name.current!.value);
  return (
    <>
      <div className="empty-illus"><Icon name="branch" /></div>
      <h2>Start a new branch</h2>
      <p className="empty-msg">{`Describe what you're changing — Beacon branches off the latest ${ctx!.defaultBranch} and declares a front-end scope for the branch, so an agent that drifts outside it gets flagged.`}</p>
      <div className="create-row">
        <input id="create-name" ref={name} className="input" type="text" placeholder="e.g. update the pricing page" autoComplete="off" disabled={dirty}
          onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
        <button className="btn signal" id="create-start" disabled={dirty} onClick={go}>Create branch</button>
      </div>
      {dirty
        ? <p className="create-hint">{`You have ${working.length} uncommitted change${working.length > 1 ? "s" : ""}. `}<button className="linklike" id="create-goto-wt" onClick={selectWorking}>Save or set them aside</button> first.</p>
        : <p className="empty-msg small">…or pick an item on the left to open it.</p>}
      <OnboardSteps active={2} />
    </>
  );
}

export function EmptyPane() {
  const st = useStore();
  const g = st.gh;
  const repo = !!(st.ctx && st.ctx.isRepo);
  // Gate the pre-repo state on a connected GitHub account.
  if (!repo) return g.authed ? <SelectRepoStep /> : <ConnectStep installed={!!g.installed} />;
  // Repo open: make sure they're up to date before prompting a branch.
  if (!st.skipSync && st.sync && st.sync.behind > 0 && !isDirty()) return <UpdateStep />;
  return <CreateStep />;
}
