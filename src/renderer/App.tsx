// The whole window. Rendered straight into <body> (no wrapper element), so
// the DOM — and every selector in styles.css — is what it was before React.

import { useStore } from "./store.ts";
import { DetailColumn } from "./components/Details.tsx";
import { ListColumn } from "./components/List.tsx";
import { MenuView, ModalView, ShipModal, Toast } from "./components/Overlays.tsx";
import { TopNav } from "./components/TopNav.tsx";

export function App() {
  const { menu } = useStore();
  return (
    <>
      <TopNav />
      <div className="workspace">
        {/* LEFT: one unified activity list. RIGHT: the detail pane. */}
        <ListColumn />
        <DetailColumn />
      </div>
      <ModalView />
      {/* Create PR: shows the PR preview, then opens it for real */}
      <ShipModal />
      <Toast />
      {menu ? <MenuView menu={menu} /> : null}
    </>
  );
}
