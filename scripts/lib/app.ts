// Drive the real Electron app over the Chrome DevTools Protocol: the renderer
// page (clicks, keys, evaluation, screenshots) and the main process (to stand
// in for the native folder picker). Used by the smoke test and the UI
// comparison.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

export class Cdp {
  private nextId = 1;
  private constructor(private ws: WebSocket) {}

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err; });
    return new Cdp(ws);
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== id) return;
        this.ws.removeEventListener("message", onMessage);
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
      };
      this.ws.addEventListener("message", onMessage);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string, { commandLineApi = false } = {}): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: commandLineApi });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  close() { this.ws.close(); }
}

async function targets(port: number): Promise<any[] | null> {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]; }
  catch { return null; }
}

async function waitForTarget(port: number, pick: (t: any) => boolean): Promise<any> {
  for (let i = 0; i < 150; i++) {
    const t = (await targets(port))?.find(pick);
    if (t) return t;
    await Bun.sleep(100);
  }
  throw new Error(`no matching debug target on port ${port}`);
}

export interface App {
  page: Cdp;
  main: Cdp;
  // Make the "Open a repository…" folder picker return this path.
  pickFolder(path: string): Promise<void>;
  close(): void;
}

export async function launchApp(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const pagePort = 9300 + Math.floor(Math.random() * 300);
  const mainPort = pagePort + 300;
  const child: ChildProcess = spawn(
    join(ROOT, "node_modules", ".bin", "electron"),
    [`--inspect=${mainPort}`, ROOT, `--remote-debugging-port=${pagePort}`],
    { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    if (/error/i.test(s) && !/Security Warning|Debugger listening|For help, see/.test(s)) process.stderr.write(s);
  });

  const main = await Cdp.connect((await waitForTarget(mainPort, (t) => !!t.webSocketDebuggerUrl)).webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  // --inspect pauses nothing, but the target may need a nudge to run.
  await main.send("Runtime.runIfWaitingForDebugger").catch(() => {});
  const pageTarget = await waitForTarget(pagePort, (t) => t.type === "page" && String(t.url).endsWith("index.html"));
  const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");

  // The preload runs before page scripts, but the target can appear first.
  for (let i = 0; i < 100; i++) {
    if ((await page.evaluate("typeof window.beacon")) === "object") break;
    await Bun.sleep(50);
  }

  return {
    page,
    main,
    async pickFolder(path: string) {
      await main.evaluate(
        `(() => { const { dialog } = require("electron"); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(path)}] }); return true; })()`,
        { commandLineApi: true },
      );
    },
    close() {
      page.close();
      main.close();
      child.kill();
    },
  };
}

// --- input -------------------------------------------------------------------

async function centerOf(page: Cdp, selector: string): Promise<{ x: number; y: number }> {
  const r = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  if (!r) throw new Error(`no element matches ${selector}`);
  return r;
}

export async function click(page: Cdp, selector: string, { button = "left" }: { button?: "left" | "right" } = {}) {
  const { x, y } = await centerOf(page, selector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
}

export async function moveMouse(page: Cdp, x: number, y: number) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

export async function typeText(page: Cdp, text: string) {
  await page.send("Input.insertText", { text });
}

const KEYS: Record<string, { code: string; keyCode: number }> = {
  Escape: { code: "Escape", keyCode: 27 },
  Enter: { code: "Enter", keyCode: 13 },
};

export async function press(page: Cdp, key: keyof typeof KEYS) {
  const k = KEYS[key]!;
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", { type, key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
  }
}

export async function waitFor(page: Cdp, expression: string, what = expression, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.evaluate(`!!(${expression})`)) return;
    await Bun.sleep(50);
  }
  const toast = await page.evaluate(`document.getElementById("toast")?.textContent || ""`).catch(() => "");
  throw new Error(`timed out waiting for ${what}${toast ? ` (last toast: "${toast}")` : ""}`);
}
