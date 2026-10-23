// Beacon renderer — talks to the engine only through window.beacon (preload bridge).

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { init } from "./actions.ts";
import { App } from "./App.tsx";

const root = createRoot(document.body);
flushSync(() => root.render(<App />));
init();
