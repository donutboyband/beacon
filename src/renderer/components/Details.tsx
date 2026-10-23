// The right column: the empty/home pane, a loading state, or a detail view
// (branch activity, PR, stash).

import { call, goHome, promptName, reloadRepoState, selectStash, toast } from "../actions.ts";
import { ago } from "../format.ts";
import { markdownBlocks } from "../format.ts";
import { state, useStore, type Pane } from "../store.ts";
import { BranchView } from "./BranchView.tsx";
import { EmptyPane } from "./EmptyPane.tsx";
import { Icon, Markdown, Spinner } from "./common.tsx";

function PrView({ dd }: Extract<Pane, { kind: "pr" }>) {
  const commits = dd.commits || [];
  const files = dd.files || [];
  return (
    <>
      <h1 className="detail-title">{dd.title}</h1>
      <div className="detail-meta">
        {dd.mergedAt ? <span className="badge dim">merged</span> : <span className="badge green">open</span>}
        <span>{`#${dd.number}`}</span><span>·</span><span>{dd.headRefName}</span><span>·</span><span>{dd.author?.login || dd.author?.name || ""}</span>
      </div>
      <div className="detail-section-h">Description</div>
      <div className="detail-body">{markdownBlocks(dd.body).length ? <Markdown md={dd.body} /> : <span className="muted">No description.</span>}</div>
      <div className="detail-section-h">{`Saves (${commits.length})`}</div>
      <div className="graph">
        {commits.length
          ? commits.map((c, i) => <div className="commit" key={i}><div className="commit-msg">{c.message}</div><div className="commit-meta">{`${c.oid} · ${c.author} · ${ago(c.date)}`}</div></div>)
          : <span className="muted">No commits.</span>}
      </div>
      <div className="detail-section-h">{`Files (${files.length})`}</div>
      <ul className="files">
        {files.length
          ? files.map((f) => <li key={f.path}><span className="file-name">{f.path}</span> <span className="file-status"><span className="add">{`+${f.additions}`}</span> <span className="del">{`−${f.deletions}`}</span></span></li>)
          : <li className="muted">none</li>}
      </ul>
      <div className="detail-actions">
        <button className="btn" data-ext={dd.url} onClick={() => window.beacon.openExternal(dd.url)}><Icon name="external" /> Open on GitHub</button>
      </div>
    </>
  );
}

function StashView({ index, dd, stash }: Extract<Pane, { kind: "stash" }>) {
  return (
    <>
      <h1 className="detail-title">{stash ? stash.label : `stash@{${index}}`}</h1>
      <div className="detail-meta"><span className="badge dim">{`stash@{${index}}`}</span><span>stashed changes</span></div>
      <div className="detail-section-h">{`Files (${dd.files.length})`}</div>
      <ul className="files">
        {dd.files.length
          ? dd.files.map((f) => <li key={f.file}><span className="dot mute"></span><span className="file-name">{f.file}</span><span className="file-status">{f.status}</span></li>)
          : <li className="muted">none</li>}
      </ul>
      <div className="detail-actions">
        {/* Restores the newest stash, whichever is open — see bridge.ts. */}
        <button className="btn primary" id="stash-restore"
          onClick={async () => { try { await call(window.beacon.stashPop(state.cwd!)); toast("Stash restored"); await reloadRepoState(); goHome(); } catch {} }}>
          Restore these changes
        </button>
        <button className="btn" id="stash-rename"
          onClick={async () => {
            const name = await promptName({ title: "Rename stash", ok: "Rename", initial: stash ? stash.label : "" });
            if (name == null) return;
            try { await call(window.beacon.stashRename(state.cwd!, index, name)); toast("Stash renamed"); await reloadRepoState(); selectStash(0); } catch {}
          }}>
          Rename
        </button>
      </div>
    </>
  );
}

function DetailContent({ pane }: { pane: Pane }) {
  switch (pane.kind) {
    case "branch-loading":
      return <div className="branch-view"><div className="branch-scroll"><div className="muted"><Spinner /> Loading…</div></div></div>;
    case "branch":
      return <BranchView name={pane.name} log={pane.log} rv={pane.rv} />;
    case "pr-loading":
      return <div className="muted">{`Loading #${pane.number}…`}</div>;
    case "pr":
      return <PrView {...pane} />;
    case "stash":
      return <StashView {...pane} />;
    default:
      return null;
  }
}

export function DetailColumn() {
  const { pane, paneKey } = useStore();
  const isEmpty = pane.kind === "empty" || pane.kind === "loading";
  const isDetail = !isEmpty && pane.kind !== "none";
  const flush = pane.kind === "branch-loading" || pane.kind === "branch";
  return (
    <section className={`detail-col${flush ? " flush" : ""}`} id="detail-col">
      <div id="detail-view" className={isDetail ? "" : "hidden"}>
        {isDetail ? <DetailContent key={paneKey} pane={pane} /> : null}
      </div>
      {/* Default detail pane: select-repo, or the create form */}
      <div id="empty-state" className={`empty-state${isEmpty ? "" : " hidden"}`}>
        {pane.kind === "empty" ? <EmptyPane key={paneKey} /> : null}
        {pane.kind === "loading"
          ? <div className="loading-center"><Spinner big /><p className="empty-msg">{pane.msg}</p></div>
          : null}
      </div>
    </section>
  );
}
