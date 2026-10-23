// Everything that floats: the popover menu, the name/confirm dialog, the
// Create PR dialog, and the toast.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DataOf } from "../../ipc/contract.ts";
import { call, closeMenu, closeModal, closeShip, connectGh, goHome, reloadRepoState, toast } from "../actions.ts";
import { state, useStore, type Menu } from "../store.ts";
import { BusyButton, Icon, Markdown, Spinner, ZoneCallout } from "./common.tsx";

// --- popover menu -------------------------------------------------------------

export function MenuView({ menu }: { menu: Menu }) {
  const el = useRef<HTMLDivElement>(null);

  // Position like the old code did: anchored menus sit under their button and
  // are kept inside the viewport; right-click menus sit at the cursor.
  useLayoutEffect(() => {
    const m = el.current!;
    if (menu.kind === "anchored") {
      const r = document.getElementById(menu.anchorId)!.getBoundingClientRect();
      m.style.top = `${Math.round(r.bottom + 5)}px`;
      m.style.minWidth = `${Math.round(Math.max(200, r.width))}px`;
      const mw = m.offsetWidth || 200;
      let left = r.left;
      if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
      m.style.left = `${Math.round(Math.max(8, left))}px`;
    } else {
      const mw = m.offsetWidth || 200, mh = m.offsetHeight || 40;
      let left = menu.x, top = menu.y;
      if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
      if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
      m.style.left = `${Math.round(Math.max(8, left))}px`;
      m.style.top = `${Math.round(Math.max(8, top))}px`;
    }
  }, [menu]);

  // Close on a mousedown outside the menu (and its anchor) or on Escape —
  // armed on the next tick so the opening click doesn't close it.
  useEffect(() => {
    const anchor = menu.kind === "anchored" ? document.getElementById(menu.anchorId) : null;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (el.current && !el.current.contains(t) && (!anchor || !anchor.contains(t))) closeMenu();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
    const arm = setTimeout(() => {
      document.addEventListener("mousedown", down, true);
      document.addEventListener("keydown", key, true);
    }, 0);
    return () => {
      clearTimeout(arm);
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [menu]);

  const pick = (i: number) => { const it = menu.items[i]!; closeMenu(); it.onClick && it.onClick(); };
  return (
    <div className="menu" ref={el}>
      {menu.items.map((it, i) => {
        if (menu.kind === "anchored" && it.separator) return <div key={i} className="menu-sep"></div>;
        if (menu.kind === "anchored" && it.header) return <div key={i} className="menu-header">{it.label}</div>;
        const extra = menu.kind === "anchored" ? (it.checked ? "checked" : "") : (it.danger ? "danger" : "");
        return (
          <button key={i} className={`menu-item ${extra}`} data-i={i} onClick={() => pick(i)}>
            <span className="menu-ico">{it.icon ? <Icon name={it.icon} /> : null}</span>
            <span className="menu-label">{it.label}</span>
            {menu.kind === "anchored" && it.checked ? <Icon name="check" cls="menu-check" /> : null}
          </button>
        );
      })}
    </div>
  );
}

// --- name / confirm dialog ---------------------------------------------------------

export function ModalView() {
  const { modal } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const confirm = modal.kind === "confirm";

  // On each open: fill and select the input (prompt) or focus OK (confirm).
  useEffect(() => {
    if (!modal.open) return;
    if (confirm) { ok.current!.focus(); return; }
    input.current!.value = modal.initial;
    input.current!.focus();
    input.current!.select();
  }, [modal.seq]);

  // Confirm listens for Enter/Escape on the whole document; prompt on its input.
  useEffect(() => {
    if (!modal.open || !confirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter") closeModal(true); else if (e.key === "Escape") closeModal(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal.seq, modal.open]);

  const onOk = () => {
    if (confirm) { closeModal(true); return; }
    const v = input.current!.value.trim();
    if (!v) { input.current!.focus(); return; }
    closeModal(v);
  };
  const onCancel = () => closeModal(confirm ? false : null);

  return (
    <div id="modal" className={`modal-overlay${modal.open ? "" : " hidden"}`} onMouseDown={(e) => { if (modal.open && e.target === e.currentTarget) onCancel(); }}>
      <div className="modal">
        <div className="modal-title" id="modal-title">{modal.title}</div>
        <input id="modal-input" ref={input} className={`input${confirm && modal.open ? " hidden" : ""}`} type="text" autoComplete="off"
          onKeyDown={(e) => { if (!modal.open || confirm) return; if (e.key === "Enter") onOk(); else if (e.key === "Escape") onCancel(); }} />
        <div className="modal-actions">
          <button className="btn" id="modal-cancel" onClick={() => { if (modal.open) onCancel(); }}>Cancel</button>
          <button className={`btn primary${confirm && modal.open ? " danger-btn" : ""}`} id="modal-ok" ref={ok} onClick={() => { if (modal.open) onOk(); }}>{modal.ok}</button>
        </div>
      </div>
    </div>
  );
}

// --- Create PR -------------------------------------------------------------------------
// Gate on a connected GitHub, then preview the PR description and open it for
// real on confirm.

type DryRun = Extract<DataOf<"beacon:ship">, { flagged: string[] }>;

function ShipBody({ onClose }: { onClose: () => void }) {
  const { gh } = state; // read once, when the dialog opens
  const authed = !!(gh && gh.authed);
  const installed = !!(gh && gh.installed);
  const [preview, setPreview] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ready"; r: DryRun; gen: number }>({ kind: "loading" });
  // Cancel and click-outside work once the first analysis has finished (or
  // straight away for the connect prompt) — as before the port.
  const [armed, setArmed] = useState(!authed);
  const gen = useRef(0);

  const renderPreview = async () => {
    setPreview({ kind: "loading" });
    try {
      const r = (await call(window.beacon.ship({ cwd: state.cwd!, dryRun: true }))) as DryRun;
      setPreview({ kind: "ready", r, gen: ++gen.current });
    } catch { setPreview({ kind: "error" }); }
  };
  useEffect(() => {
    if (!authed) return;
    renderPreview().then(() => setArmed(true));
  }, []);

  const blocked = preview.kind === "ready" && !!(preview.r.flagged && preview.r.flagged.length);
  const revert = async (files: string[] | undefined, doneMsg: (res: DataOf<"beacon:revertOutOfScope">) => string) => {
    const res = await call(window.beacon.revertOutOfScope(state.cwd!, files));
    toast(res.reverted ? doneMsg(res) : "Nothing to revert");
    await reloadRepoState();
    await renderPreview();
  };

  let body: ReactNode;
  let confirm: ReactNode;
  if (!authed) {
    // Not connected — the dialog becomes a connect prompt.
    body = (
      <div className="connect-panel">
        <Icon name="pull-request" cls="cp-ico" />
        <div>
          <div className="cp-title">{installed ? "Connect GitHub to open a pull request" : "GitHub CLI not found"}</div>
          <p className="muted">{installed
            ? "Sign in once and Beacon can push your branch and open the PR for you. Beacon stores nothing — your GitHub CLI handles the sign-in."
            : "Install the GitHub CLI (gh) from cli.github.com, then connect your account here."}</p>
        </div>
      </div>
    );
    confirm = <button className="btn primary" id="ship-confirm" onClick={() => { onClose(); connectGh(); }}>{installed ? "Connect GitHub" : "Get the GitHub CLI"}</button>;
  } else if (preview.kind !== "ready") {
    body = preview.kind === "loading"
      ? <div className="muted"><Spinner /> Analyzing your changes…</div>
      : <div className="muted">Couldn't analyze the changes on this branch.</div>;
    confirm = <button className="btn primary" id="ship-confirm" disabled>Create pull request</button>;
  } else {
    const { r } = preview;
    const n = r.flagged ? r.flagged.length : 0;
    // The pre-PR review: everything Beacon flagged, each with its own revert.
    // Whatever is kept ships flagged in the PR description.
    body = (
      <>
        {blocked ? (
          <ZoneCallout cls="alert" tag={{ text: "action needed", cls: "act" }}
            title="Flagged — decide before the PR"
            body={`${n} change${n > 1 ? "s" : ""} ${n > 1 ? "are" : "is"} outside the front-end scope declared for this branch. Revert what shouldn't ship; anything you keep is flagged for the reviewer in the PR description.`}>
            <ul className="files flagged">
              {r.flagged.map((f) => (
                <li key={f}>
                  <span className="dot red"></span><span className="file-name">{f}</span>
                  <BusyButton className="btn small danger-btn" data-revert-file={f} busyLabel="Reverting" onRun={() => revert([f], () => `Reverted ${f}`)}>Revert</BusyButton>
                </li>
              ))}
            </ul>
            <div className="callout-row">
              <BusyButton className="btn small danger-btn" id="revert-oz" busyLabel="Reverting"
                onRun={() => revert(undefined, (res) => `Reverted ${res.reverted} flagged change${res.reverted > 1 ? "s" : ""}`)}>Revert all flagged</BusyButton>
            </div>
          </ZoneCallout>
        ) : null}
        <div className="preview-head"><span className="badge dim">{r.annotation.source}</span></div>
        <div className="preview-body"><Markdown md={r.annotation.body} /></div>
      </>
    );
    confirm = (
      <BusyButton key={preview.gen} className="btn primary" id="ship-confirm" busyLabel="Creating"
        onRun={async () => {
          const res = await call(window.beacon.ship({ cwd: state.cwd!, dryRun: false, title: r.annotation && r.annotation.title, allowFlagged: blocked }));
          toast(`Pull request created: ${"prUrl" in res ? res.prUrl : ""}`);
          onClose();
          await reloadRepoState();
          goHome();
        }}>{blocked ? "Create PR & flag" : "Create pull request"}</BusyButton>
    );
  }

  return (
    <>
      <div id="ship-preview" className="ship-preview">{body}</div>
      <div className="modal-actions">
        <button className="btn" id="ship-cancel" onClick={() => { if (armed) onClose(); }}>Cancel</button>
        {confirm}
      </div>
      <ArmOverlay armed={armed} onClose={onClose} />
    </>
  );
}

// Click on the dimmed backdrop closes the dialog (once armed).
function ArmOverlay({ armed, onClose }: { armed: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!armed) return;
    const overlay = document.getElementById("ship-modal")!;
    const onDown = (e: MouseEvent) => { if (e.target === overlay) onClose(); };
    overlay.addEventListener("mousedown", onDown);
    return () => overlay.removeEventListener("mousedown", onDown);
  }, [armed]);
  return null;
}

export function ShipModal() {
  const { ship } = useStore();
  return (
    <div id="ship-modal" className={`modal-overlay${ship.open ? "" : " hidden"}`}>
      <div className="modal wide">
        <div className="modal-title">{ship.title}</div>
        {ship.open
          ? <ShipBody key={ship.seq} onClose={closeShip} />
          : (
            <>
              <div id="ship-preview" className="ship-preview"></div>
              <div className="modal-actions">
                <button className="btn" id="ship-cancel">Cancel</button>
                <button className="btn primary" id="ship-confirm" disabled>Create pull request</button>
              </div>
            </>
          )}
      </div>
    </div>
  );
}

export function Toast() {
  const { toast } = useStore();
  return <div id="toast" className={`toast${toast.visible ? "" : " hidden"}`}>{toast.text}</div>;
}
