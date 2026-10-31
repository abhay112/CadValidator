import "./style.css";
import type { FromWorker, KidEntry, KidKind, SampleKind, ToWorker } from "../lib/types";
import { UniquenessRegistry } from "../lib/uniqueness";
import { bytesLabel, esc } from "./format";
import { cardHtml, type Item } from "./render";
import { Viewer } from "./viewer";

const MAX_BYTES = 150 * 1024 * 1024;
const MESH = /\.(stl|obj|3mf)$/i;
const ACCEPT = /\.(step|stp|fcstd|sldprt|prt|f3d|ipt)$/i;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)"/><path d="M16 6l9 5v10l-9 5-9-5V11z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M7 11l9 5 9-5M16 16v10" fill="none" stroke="#fff" stroke-width="2"/></svg>
      <div><h1>CAD Validator</h1><p>STEP and FreeCAD checks that run in your browser</p></div></div>
    <div class="engine" id="engine" role="status" aria-live="polite"></div>
  </header>
  <main>
    <label class="drop" id="drop" for="file">
      <input id="file" type="file" accept=".step,.stp,.fcstd,.FCStd,.sldprt,.prt,.f3d,.ipt" multiple />
      <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5l5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="t">Drop <b>.step</b>, <b>.stp</b> or <b>.FCStd</b> files here</span>
      <span class="s">or click to browse · several files at once is fine</span>
    </label>
    <p class="privacy">🔒 Files are read and checked locally with a WebAssembly build of OpenCASCADE. Nothing is uploaded, stored or sent to a server.</p>
    <div class="samples">No file handy? Generate one in your browser:
      <button class="link" data-sample="flange">flange (should pass)</button>
      <button class="link" data-sample="strip">thin strip (fails proportions)</button>
      <button class="link" data-sample="cube">cube (fails face count)</button>
      <button class="link" data-sample="fcstd">FCStd assembly</button>
    </div>
    <div class="list-head" id="listHead" hidden><span id="summary"></span><button class="ghost" id="clear">Clear all</button></div>
    <div id="results" aria-live="polite"></div>
  </main>
 `;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const engineEl = $("engine");
const resultsEl = $("results");

/* ---------- worker ---------- */

/** A file this slow leaves the engine's WASM heap bloated, which slows or stalls the next one: start a fresh engine. */
const RECYCLE_AFTER_MS = 30_000;
let worker: Worker;
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
let ready = false;
const registry = new UniquenessRegistry();
const items: Item[] = [];
const buffers = new Map<number, ArrayBuffer>();
const viewers = new Map<number, Viewer>();
const sampleWaiters = new Map<number, { ok: (f: File) => void; fail: (message: string) => void }>();
let nextId = 1;
let busy = false;

function setEngine(html: string, cls = "") {
  engineEl.className = `engine ${cls}`;
  engineEl.innerHTML = html;
}
let startedAt = 0;

/** Helper workers for the parts of one assembly; each loads its own copy of the engine, so keep the count modest. */
const HELPERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));

function showStage(id: number, text: string) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  it.stage = text;
  // Update the badge in place; a full re-render would be wasteful while the workers are busy.
  const badge = document.querySelector(`[data-id="${it.id}"]`)?.closest(".card")?.querySelector(".badge.wait");
  if (badge) badge.textContent = text;
}

/**
 * Check an assembly's parts on short-lived helper workers that pull one part at a time (so big and small parts balance
 * out), then hand the outcomes to the main worker, which is busy with the whole-model passes. Any failure answers
 * null and the main worker simply checks the parts itself.
 */
function runKids(id: number, count: number, source: ArrayBuffer, kind: KidKind) {
  const entries: KidEntry[] = [];
  const helpers: Worker[] = [];
  let next = 0;
  let finished = false;
  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true;
    for (const h of helpers) h.terminate();
    send({ type: "kids", id, entries: ok ? entries : null });
  };
  const assign = (h: Worker) => {
    if (next < count) h.postMessage({ type: "job", id, index: next++ } satisfies ToWorker);
  };
  showStage(id, `Checking parts 0 of ${count}\u2026`);
  for (let n = 0; n < Math.min(HELPERS, count); n++) {
    const h = new Worker(new URL("../worker/worker.ts", import.meta.url), { type: "module" });
    helpers.push(h);
    h.onerror = () => finish(false);
    h.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === "ready") {
        const copy = source.slice(0);
        h.postMessage({ type: "prep", id, buffer: copy, kind } satisfies ToWorker, [copy]);
      } else if (m.type === "prepared") {
        if (m.count === count) assign(h);
        else finish(false);
      } else if (m.type === "entry") {
        entries.push(m.entry);
        if (entries.length === count) {
          showStage(id, "Finishing the whole-model check\u2026");
          finish(true);
        } else {
          showStage(id, `Checking parts ${entries.length} of ${count}\u2026`);
          assign(h);
        }
      } else if (m.type === "error" || m.type === "initError") {
        finish(false);
      }
    };
    h.postMessage({ type: "init" } satisfies ToWorker);
  }
}

function boot() {
  ready = false;
  worker = new Worker(new URL("../worker/worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = onMessage;
  worker.onerror = (e) => setEngine(`Engine crashed: ${esc(e.message)}`, "bad");
  setEngine('<span class="spin"></span> Starting geometry engine…');
  send({ type: "init" });
}

function onMessage(ev: MessageEvent<FromWorker>) {
  const msg = ev.data;
  switch (msg.type) {
    case "progress": {
      const total = msg.total || 65_864_037;
      const pct = Math.min(99, Math.round((msg.loaded / total) * 100));
      setEngine(`<span class="spin"></span> Loading geometry engine ${bytesLabel(msg.loaded)} (${pct}%) <span class="hint">first visit only, then cached</span>`);
      break;
    }
    case "ready":
      ready = true;
      setEngine("● Engine ready", "ok");
      pump();
      break;
    case "initError":
      setEngine(`Engine failed to load: ${esc(msg.message)} <button class="link" id="retry">Retry</button>`, "bad");
      document.getElementById("retry")?.addEventListener("click", () => {
        setEngine('<span class="spin"></span> Starting geometry engine…');
        send({ type: "init" });
      });
      break;
    case "sample": {
      const waiter = sampleWaiters.get(msg.id);
      sampleWaiters.delete(msg.id);
      waiter?.ok(new File([msg.buffer], msg.name));
      break;
    }
    case "stage":
      showStage(msg.id, msg.text);
      break;
    case "needKids":
      runKids(msg.id, msg.count, msg.buffer, msg.kind);
      break;
    case "result": {
      const it = items.find((i) => i.id === msg.id);
      busy = false;
      if (it) {
        it.status = "done";
        it.report = msg.report;
        const sigs = msg.report.signatures;
        it.comparedWith = new Set(items.filter((o) => o !== it && o.status === "done").map((o) => o.name)).size;
        it.matches = registry.check(it.name, sigs);
        registry.add(it.name, sigs);
      }
      buffers.delete(msg.id);
      render();
      if (Date.now() - startedAt > RECYCLE_AFTER_MS) {
        worker.terminate();
        boot();
      }
      pump();
      break;
    }
    case "error": {
      const waiter = sampleWaiters.get(msg.id);
      if (waiter) {
        sampleWaiters.delete(msg.id);
        waiter.fail(msg.message);
        break;
      }
      const it = items.find((i) => i.id === msg.id);
      busy = false;
      if (it) {
        it.status = "error";
        it.error = msg.message;
      }
      buffers.delete(msg.id);
      render();
      pump();
      break;
    }
  }
}

boot();

/* ---------- queue ---------- */

function pump() {
  if (!ready || busy) return;
  const next = items.find((i) => i.status === "queued");
  if (!next) return;
  const buffer = buffers.get(next.id);
  if (!buffer) return;
  busy = true;
  startedAt = Date.now();
  next.status = "running";
  render();
  // Let the "Checking…" state paint first. A timer, not requestAnimationFrame: that never fires in a background tab.
  setTimeout(() => send({ type: "validate", id: next.id, name: next.name, buffer }, [buffer]), 30);
}

async function addFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    const id = nextId++;
    if (!ACCEPT.test(file.name)) {
      items.unshift({ id, name: file.name, size: file.size, status: "error", error: MESH.test(file.name) ? "Mesh files (.stl, .obj, .3mf) are not accepted: a STEP export of the exact B-rep geometry is required." : "Supported: .step, .stp, .FCStd, .SLDPRT, .PRT, .F3D, .IPT." });
    } else if (file.size > MAX_BYTES) {
      items.unshift({ id, name: file.name, size: file.size, status: "error", error: `File is ${bytesLabel(file.size)}; the in-browser limit is ${bytesLabel(MAX_BYTES)}.` });
    } else {
      items.unshift({ id, name: file.name, size: file.size, status: "queued" });
      buffers.set(id, await file.arrayBuffer());
    }
  }
  render();
  pump();
}

function sample(kind: SampleKind) {
  if (!ready) return setEngine(engineEl.innerHTML + " — samples need the engine, one moment.", engineEl.className.replace("engine ", ""));
  const id = nextId++;
  sampleWaiters.set(id, {
    ok: (f) => void addFiles([f]),
    fail: (message) => {
      items.unshift({ id, name: `sample (${kind})`, size: 0, status: "error", error: `Could not generate the sample: ${message}` });
      render();
    },
  });
  send({ type: "sample", id, kind });
}

/* ---------- rendering ---------- */

function mountViewers() {
  for (const slot of resultsEl.querySelectorAll<HTMLElement>(".viewer-slot")) {
    const id = Number(slot.dataset.id);
    const preview = items.find((i) => i.id === id)?.report?.preview;
    if (!preview) continue;
    let v = viewers.get(id);
    if (!v) {
      try {
        v = new Viewer(preview);
      } catch {
        slot.textContent = "3D view needs WebGL, which is unavailable in this browser.";
        continue;
      }
      viewers.set(id, v);
    }
    slot.append(v.el);
    v.attached();
  }
}

function dropViewer(id: number) {
  viewers.get(id)?.dispose();
  viewers.delete(id);
}

function render() {
  // Detach live viewers first so rebuilding the list does not destroy their WebGL canvases.
  for (const v of viewers.values()) v.el.remove();
  resultsEl.innerHTML = items.map(cardHtml).join("");
  mountViewers();
  const done = items.filter((i) => i.report);
  const pass = done.filter((i) => i.report!.passed).length;
  const unchecked = done.filter((i) => i.report!.format === "native").length;
  $("listHead").hidden = items.length === 0;
  $("summary").textContent = items.length
    ? `${items.length} file${items.length === 1 ? "" : "s"}${done.length ? ` · ${pass} passed · ${done.length - pass - unchecked} failed${unchecked ? ` · ${unchecked} not checked` : ""}` : ""}`
    : "";
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- events ---------- */

const fileInput = $<HTMLInputElement>("file");
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) void addFiles(fileInput.files);
  fileInput.value = "";
});
const drop = $("drop");
["dragenter", "dragover"].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  }),
);
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  if ((e as DragEvent).dataTransfer?.files.length) void addFiles((e as DragEvent).dataTransfer!.files);
});
// A file dropped outside the zone should not make the browser navigate to it.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!drop.contains(e.target as Node) && e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
});

document.querySelectorAll<HTMLButtonElement>("[data-sample]").forEach((b) => b.addEventListener("click", () => sample(b.dataset.sample as SampleKind)));

$("clear").addEventListener("click", () => {
  items.length = 0;
  buffers.clear();
  for (const id of [...viewers.keys()]) dropViewer(id);
  registry.clear();
  render();
});

resultsEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const it = items.find((i) => i.id === id);
  if (!it) return;
  if (btn.dataset.act === "remove") {
    items.splice(items.indexOf(it), 1);
    buffers.delete(id);
    dropViewer(id);
    registry.remove(it.name);
    render();
  } else if (btn.dataset.act === "reset") {
    viewers.get(id)?.reset();
  } else if (btn.dataset.act === "json" && it.report) {
    const text = JSON.stringify(it.report, (k, v) => (k === "preview" ? undefined : v), 2);
    download(`${it.name.replace(/\.[^.]+$/, "")}.validation.json`, text);
  }
});

render();
