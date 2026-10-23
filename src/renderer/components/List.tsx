// The left column. Two tabs, designer-legible: BRANCHES is where work happens
// (working tree + in-progress branches + stashed changes, live-updating); PRS
// is where work goes after (in review → done / deleted).

import { useEffect, useRef, type ReactNode } from "react";
import { connectGh, refreshView, rowContextMenu, selectPR, selectStash, selectWorking, setTab, switchBranch, toggleGroup } from "../actions.ts";
import { ago, prettyBranch } from "../format.ts";
import { isDirty, set, state, useStore, type PrSummary } from "../store.ts";
import { Icon, Spinner } from "./common.tsx";

interface RowProps {
  cls: string;
  type: "working" | "branch" | "pr" | "stash";
  id?: string | number;
  iconName: string;
  col?: string;
  title: string;
  sub: string;
  tag?: string;
}

function Row({ cls, type, id, iconName, col, title, sub, tag }: RowProps) {
  const s = state.selected as any;
  const sel = s && s.type === type && (id === undefined || s.index === id || s.number === id || s.branch === id) ? "active" : "";
  const onClick = () => {
    if (type === "working") selectWorking();
    else if (type === "pr") selectPR(Number(id));
    else if (type === "stash") selectStash(Number(id));
    else if (type === "branch") switchBranch(String(id));
  };
  return (
    <li className={`row-item ${cls} ${sel}`} data-type={type} data-id={id !== undefined ? String(id) : undefined} onClick={onClick}>
      <span className="row-ico" style={col ? { color: col } : undefined}><Icon name={iconName} /></span>
      <span className="row-main">
        <span className="row-title">{title}{tag ? <span className="row-tag">{tag}</span> : null}</span>
        <span className="row-sub">{sub}</span>
      </span>
    </li>
  );
}

function prRow(p: PrSummary) {
  const s = p.state;
  return (
    <Row key={`pr-${p.number}`} cls="pr" type="pr" id={p.number}
      iconName={s === "MERGED" ? "merge" : s === "CLOSED" ? "x-circle" : p.isDraft ? "circle-dashed" : "pull-request"}
      col={s === "MERGED" ? "var(--purple)" : s === "CLOSED" ? "var(--red)" : p.isDraft ? "var(--mute)" : "var(--green)"}
      title={p.title}
      sub={`#${p.number} · ${p.headRefName}${p.isDraft ? " · draft" : ""} · ${ago(p.updatedAt)}`} />
  );
}

// A collapsible Linear-style group: a full-width band (a "break" in the list),
// a status dot, a name and a count, then its rows.
function Section({ groupKey, label, count, color, children }: { groupKey: string; label: string; count: number; color: string; children: ReactNode }) {
  const collapsed = state.collapsed.has(groupKey);
  return (
    <>
      <li className={`group-head ${collapsed ? "collapsed" : ""}`} data-group={groupKey} onClick={() => toggleGroup(groupKey)}>
        <Icon name="caret-down" cls="group-chev" />
        <span className="group-dot" style={{ background: color }}></span>
        <span className="group-name">{label}</span>
        <span className="group-count">{count}</span>
      </li>
      {collapsed ? null : children}
    </>
  );
}

function Rows() {
  const st = useStore();
  if (st.listLoading) return <li className="list-empty"><Spinner />{` ${st.listLoading}`}</li>;
  if (!st.ctx || !st.ctx.isRepo) return <li className="list-empty">Open a repository to see its activity.</li>;
  const q = (st.query || "").trim().toLowerCase();
  const m = (s: unknown) => !q || String(s).toLowerCase().includes(q);
  const prMatch = (p: PrSummary) => m(p.title) || m(p.headRefName) || m("#" + p.number);
  const prs = st.prsAvailable ? st.prs : [];
  // A branch is "shipped" once it has an open or merged PR — then it shows up as
  // that PR, not as a separate in-progress branch.
  const shipped = new Set(prs.filter((p) => p.state !== "CLOSED").map((p) => p.headRefName));
  const open = prs.filter((p) => p.state === "OPEN" && prMatch(p));
  const merged = prs.filter((p) => p.state === "MERGED" && prMatch(p));
  const closed = prs.filter((p) => p.state === "CLOSED" && prMatch(p));
  const inProgress = st.branches.filter((b) => !b.isDefault && !shipped.has(b.name) && (m(b.name) || m(prettyBranch(b.name))));
  const stashes = st.stashes.filter((s) => m(s.label));
  const showWorking = isDirty() && m(`working tree uncommitted changes ${st.ctx.branch}`);

  // When searching, drop groups that have no matches; otherwise keep them (with
  // their empty-state placeholder) so the list structure stays stable.
  const sect = <T,>(key: string, label: string, color: string, items: T[], row: (x: T) => ReactNode, emptyText: string) => {
    if (q && !items.length) return null;
    return (
      <Section key={key} groupKey={key} label={label} count={items.length} color={color}>
        {items.length ? items.map(row) : <li className="list-empty sub">{emptyText}</li>}
      </Section>
    );
  };

  const out: ReactNode[] = [];
  if (st.tab === "branches") {
    // Pinned Working tree row — uncommitted changes are always reachable here.
    if (showWorking) {
      out.push(<Row key="working" cls="working" type="working" iconName="pencil" col="var(--amber)"
        title="Working tree" sub={`${st.working.length} uncommitted change${st.working.length > 1 ? "s" : ""} · on ${st.ctx.branch}`} />);
    }
    out.push(sect("inprogress", "In progress", "var(--blue)", inProgress,
      (b) => <Row key={`b-${b.name}`} cls="branch" type="branch" id={b.name} iconName="branch" col="var(--blue)"
        title={prettyBranch(b.name)} sub={`${b.name}${b.date ? ` · ${ago(b.date)}` : ""}`} tag={b.current ? "current" : ""} />,
      "Nothing in progress — start a new branch."));
    // Stashes are set-aside WORKING changes, so they live with branches.
    if (stashes.length) {
      out.push(
        <Section key="stashes" groupKey="stashes" label="Stashes" count={stashes.length} color="var(--mute)">
          {stashes.map((s) => <Row key={`s-${s.index}`} cls="stash" type="stash" id={s.index} iconName="archive" col="var(--mute)" title={s.label} sub={`stash@{${s.index}}`} />)}
        </Section>,
      );
    }
  } else if (!st.prsAvailable) {
    if (!q) {
      out.push(st.gh && st.gh.authed
        ? <li key="nogh" className="list-empty sub">No GitHub remote found for this repo.</li>
        : <li key="nogh" className="list-empty sub"><button className="linklike" data-connect="" onClick={() => connectGh()}>Connect GitHub</button> to track pull requests.</li>);
    }
  } else {
    out.push(sect("inreview", "In review", "var(--green)", open, prRow, "Nothing in review."));
    out.push(sect("done", "Done", "var(--purple)", merged, prRow, "Nothing merged yet."));
    if (closed.length) out.push(<Section key="deleted" groupKey="deleted" label="Deleted" count={closed.length} color="var(--red)">{closed.map(prRow)}</Section>);
  }
  if (q && !out.some(Boolean)) return <li className="list-empty">{`No matches for “${st.query.trim()}”.`}</li>;
  return <>{out}</>;
}

// Activity search: a filter input that replaces the tabs while open.
function toggleSearch(input: HTMLInputElement | null, force?: boolean) {
  const open = force !== undefined ? force : !state.searchOpen;
  set({ searchOpen: open });
  if (!input) return;
  if (open) { input.focus(); input.select(); }
  else if (state.query) { input.value = ""; set({ query: "" }); }
}

export function ListColumn() {
  const st = useStore();
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = rows.current!;
    const onCtx = (e: MouseEvent) => rowContextMenu(e);
    ul.addEventListener("contextmenu", onCtx);
    return () => ul.removeEventListener("contextmenu", onCtx);
  }, []);
  return (
    <section className="list-col">
      <div className="list-head">
        <div className={`list-tabs${st.searchOpen ? " hidden" : ""}`} id="list-tabs">
          <button className={`list-tab${st.tab === "branches" ? " active" : ""}`} data-tab="branches" onClick={() => setTab("branches")}>Branches</button>
          <button className={`list-tab${st.tab === "prs" ? " active" : ""}`} data-tab="prs" onClick={() => setTab("prs")}>PRs</button>
        </div>
        <input id="list-search" ref={search} className={`list-search${st.searchOpen ? "" : " hidden"}`} type="text" placeholder="Filter…" autoComplete="off"
          onInput={(e) => set({ query: (e.target as HTMLInputElement).value })}
          onKeyDown={(e) => { if (e.key === "Escape") toggleSearch(search.current, false); }} />
        <div className="list-head-actions">
          <button className="icon-btn" id="list-search-btn" title="Search activity" onClick={() => toggleSearch(search.current)}>
            <Icon name="search" />
          </button>
          <button className="icon-btn" id="list-refresh" title="Refresh" onClick={() => { if (state.cwd) refreshView(); }}>
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <ul className="rows" id="rows" ref={rows}>
        <Rows />
      </ul>
    </section>
  );
}
