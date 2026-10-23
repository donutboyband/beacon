// Preload (sandbox-safe; built to out/preload.cjs). Exposes a minimal,
// explicit API to the renderer via contextBridge — no Node, no ipcRenderer
// leaked to the page. The API itself is in bridge.ts; this entry must not
// export anything (see there).

import { contextBridge, ipcRenderer } from "electron";
import { createApi } from "./bridge.ts";

contextBridge.exposeInMainWorld("beacon", createApi(ipcRenderer));
