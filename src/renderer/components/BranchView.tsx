// The branch activity view — the main working surface. Shows what's happened
// on this branch (saves + change counts), with a sticky action bar: save /
// stash / restore on the left, Create PR on the right.

import { useRef } from "react";
import { call, doStash, openShip, reloadRepoState, selectBranch, toast } from "../actions.ts";
import { ago, prettyBranch } from "../format.ts";
import { isDirty, state, useStore, type Pane } from "../store.ts";
import { BusyButton, Icon, Markdown, ZoneCallout } from "./common.tsx";

type BranchPane = Extract<Pane, { kind: "branch" }>;

function AgentButtons() {
  const { agents, cwd } = useStore();
  const open = async (agent: string) => {
    try { await call(window.beacon.openIn(agent, cwd!)); toast(`Opening in ${agent}…`); } catch {}
  };
  if (!agents.cursor && !agents.claude) return null;
  return (
    <div className="agents-row">
      {agents.cursor ? <button className="btn small" data-agent="cursor" onClick={() => open("cursor")}>Open in Cursor</button> : null}
      {agents.claude ? <button className="btn small" data-agent="claude" onClick={() => open("claude")}>Open in Claude Code</button> : null}
    </div>
  );
}

export function BranchView({ name, log, rv }: Omit<BranchPane, "kind">) {
  const st = useStore();
  const msg = useRef<HTMLInputElement>(null);
  const commits = log.commits || [];
  const dirty = isDirty();
  const files = rv ? rv.files : st.working;
  const changed = files.length;
  const ozFiles = rv ? rv.flagged : st.working.filter((f) => f.outOfScope).map((f) => ({ ...f, reason: "" }));
  const ozTotal = ozFiles.length;
  const protoFiles = rv ? rv.prototype : st.working.filter((f) => f.prototype);
  const inScope = changed - ozTotal - protoFiles.length;

  const reRender = async () => { await reloadRepoState(); selectBranch(name); };
  const save = async () => {
    const r = await call(window.beacon.commit(state.cwd!, msg.current!.value.trim(), true));
    toast(r.flagged ? `Saved · ${r.flagged} file${r.flagged > 1 ? "s" : ""} flagged as out of scope` : "Saved");
    await reRender();
  };
  const saveButton = useRef<HTMLButtonElement>(null);

  // The status band: today's numbers as labelled stats (deliberately NOT the
  // dotted mono line the Saves history uses), with the live pulse and scope
  // pills docked right. Everything here moves as the agent works — nothing
  // needs to be saved/committed to show up.
  const adds = rv && rv.stat ? (rv.stat.match(/(\d+) insertions?\(/) || [])[1] : null;
  const dels = rv && rv.stat ? (rv.stat.match(/(\d+) deletions?\(/) || [])[1] : null;

  // WHAT BEACON NOTICED — pure history, rendered as a boxed watch log (mono
  // time column, tool keycap, severity edge) so it can't be mistaken for the
  // Saves timeline. Nothing here is actionable; resolved drifts stay, dimmed
  // and struck through, so the story stays complete.
  const events = (rv && rv.events) || [];

  const onDefault = !!(st.ctx && name === st.ctx.defaultBranch);
  const canPR = !onDefault && (commits.length > 0 || dirty);

  return (
    <div className="branch-view">
      <div className="branch-scroll">
        <h1 className="detail-title">{prettyBranch(name)}</h1>
        <div className="stat-row">
          <div className="stat"><span className="stat-num">{commits.length}</span><span className="stat-label">{`save${commits.length !== 1 ? "s" : ""}`}</span></div>
          <div className="stat"><span className="stat-num">{changed}</span><span className="stat-label">{`file${changed !== 1 ? "s" : ""} changed`}</span></div>
          {adds || dels
            ? <div className="stat"><span className="stat-num"><span className="add">{`+${adds || 0}`}</span> <span className="del">{`−${dels || 0}`}</span></span><span className="stat-label">lines</span></div>
            : null}
          <div className="stat-live">
            <span className="live-dot" title="Beacon is watching this repo — updates appear as files change"></span>
            <span className="live-label">watching live</span>
            <span className={`scope-pill ${inScope ? "on-in" : ""}`}>{`${inScope} in scope`}</span>
            <span className={`scope-pill ${protoFiles.length ? "on-proto" : ""}`}>{`${protoFiles.length} prototype`}</span>
            <span className={`scope-pill ${ozTotal ? "on-flag" : ""}`}>{`${ozTotal} flagged`}</span>
          </div>
        </div>
        <AgentButtons />
        <div className="detail-section-h">What to look out for</div>
        {/* RED card = decide something before the PR. PURPLE card = good to
            know, nothing to do. Green line = all clear. */}
        {ozTotal ? (
          <ZoneCallout cls="alert" tag={{ text: "action needed", cls: "act" }}
            title="Flagged — decide before the PR"
            body={`Nothing was blocked, but ${ozTotal === 1 ? "this change" : "these changes"} sit${ozTotal === 1 ? "s" : ""} outside the front-end scope declared for this branch. Revert what shouldn't ship; anything kept is flagged for the developer in the PR.`}>
            <ul className="files flagged">
              {ozFiles.map((f) => (
                <li key={f.file}>
                  <span className="dot red"></span>
                  <div className="flag-main"><span className="file-name">{f.file}</span><span className="flag-reason">{f.reason || "outside the declared scope"}</span></div>
                  <span className="file-status">{f.status}</span>
                  {/* Per-file revert — the one-click undo for a single drift. */}
                  <BusyButton className="btn small danger-btn" data-revert-file={f.file}
                    onRun={async () => {
                      const res = await call(window.beacon.revertOutOfScope(state.cwd!, [f.file]));
                      toast(res.reverted ? `Reverted ${f.file}${res.committed ? " · new commit" : ""}` : "Nothing to revert");
                      await reRender();
                    }}>Revert</BusyButton>
                </li>
              ))}
            </ul>
          </ZoneCallout>
        ) : null}
        {protoFiles.length ? (
          <ZoneCallout tag={{ text: "nothing to do", cls: "fyi" }}
            title="Prototype — built in front of the backend"
            body={<>{`${protoFiles.length} file${protoFiles.length > 1 ? "s" : ""} under `}<code>.beacon/prototype/</code> render the repo's real components on mock data instead of touching the backend.</>}>
            <ul className="files">
              {protoFiles.map((f) => <li key={f.file}><span className="dot mute"></span><span className="file-name">{f.file}</span><span className="file-status">{f.status}</span></li>)}
            </ul>
            {rv && rv.protoNotes
              ? <div className="proto-notes"><div className="proto-notes-h">Backend work needed to make it real</div><Markdown md={rv.protoNotes} /></div>
              : null}
          </ZoneCallout>
        ) : null}
        {!ozTotal && !protoFiles.length && changed
          ? <div className="all-clear"><Icon name="check" /> Everything on this branch is inside the declared front-end scope.</div>
          : !changed ? <div className="muted">No changes yet — open the repo in an agent and direct it; edits show up here as they happen.</div> : null}
        {dirty ? (
          <>
            <div className="detail-section-h">{`Unsaved changes (${st.working.length})`}</div>
            {/* Each unsaved row gets its own Save — commit just that file,
                leaving the rest of the working tree untouched. Uses the message
                from the bar if one is typed, else a per-file default. */}
            <ul className="files">
              {st.working.map((f) => (
                <li key={f.file}>
                  <span className={`dot ${f.outOfScope ? "red" : f.prototype ? "mute" : "green"}`}></span>
                  <span className="file-name">{f.file}</span>
                  <span className="file-status">{`${f.status}${f.outOfScope ? " · out of scope" : f.prototype ? " · prototype" : ""}`}</span>
                  <BusyButton className="btn small" data-save-file={f.file} title="Save (commit) just this file"
                    onRun={async () => {
                      const m = msg.current ? msg.current.value.trim() : "";
                      const r = await call(window.beacon.commit(state.cwd!, m, true, [f.file]));
                      toast(r.flagged ? `Saved ${f.file} · flagged as out of scope` : `Saved ${f.file}`);
                      await reRender();
                    }}>Save</BusyButton>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="detail-section-h">Saves</div>
        {commits.length
          ? (
            <div className="graph">
              {commits.map((c, i) => (
                <div className="commit" key={i}>
                  <div className="commit-msg">{c.message}</div>
                  <div className="commit-meta">{`${c.oid} · ${ago(c.date)} · ${c.files} file${c.files !== 1 ? "s" : ""} · `}<span className="add">{`+${c.additions}`}</span> <span className="del">{`−${c.deletions}`}</span></div>
                </div>
              ))}
            </div>
          )
          : <div className="muted">No saves yet. Make your edits, then Save to record the first one.</div>}
        {events.length ? (
          <>
            <div className="detail-section-h">What Beacon noticed <span className="zone-tag mute">history</span></div>
            <div className="section-hint">What Beacon noticed while the agent worked — anything you've already dealt with stays here, dimmed.</div>
            <div className="watchlog">
              {events.map((e, i) => (
                <div key={i} className={`wl-row ${e.resolved ? "resolved" : ""}`} title={e.reason || ""}>
                  <span className="wl-time">{ago(e.ts)}</span>
                  <span className="wl-tool">{e.tool || "write"}</span>
                  <span className="wl-text">went outside the scope — <code>{e.file}</code></span>
                  <span className="wl-state">{e.resolved ? "resolved" : "still flagged"}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="action-bar">
        <div className="ab-left">
          <input id="ab-msg" ref={msg} className="input ab-msg" type="text" placeholder="Describe what you changed…" autoComplete="off" disabled={!dirty}
            onKeyDown={(e) => { if (e.key === "Enter") saveButton.current?.click(); }} />
          <BusyButton ref={saveButton} className="btn primary small" id="ab-save" disabled={!dirty} busyLabel="Saving" onRun={save}>Save</BusyButton>
          <button className="btn small" id="ab-stash" disabled={!dirty} onClick={async () => { try { if (await doStash()) await reRender(); } catch {} }}>Stash</button>
          <BusyButton className="btn small" id="ab-restore" disabled={!st.stashes.length}
            onRun={async () => { await call(window.beacon.stashPop(state.cwd!)); toast("Stash restored"); await reRender(); }}>Restore stash</BusyButton>
          <BusyButton className="btn small danger-btn" id="ab-revert" disabled={!ozTotal} title="Revert every change Beacon flagged as out of scope" busyLabel="Reverting"
            onRun={async () => {
              const res = await call(window.beacon.revertOutOfScope(state.cwd!));
              toast(res.reverted ? `Reverted ${res.reverted} flagged change${res.reverted > 1 ? "s" : ""}${res.committed ? " · new commit" : ""}` : "No flagged changes to revert");
              await reRender();
            }}>Revert flagged</BusyButton>
        </div>
        <div className="ab-right">
          <button className="btn primary" id="ab-createpr" disabled={!canPR} onClick={openShip}><Icon name="pull-request" /> Create PR</button>
        </div>
      </div>
    </div>
  );
}

