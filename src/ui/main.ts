import "./style.css";
import type { FromWorker, SampleKind, ToWorker } from "../lib/types";
import { UniquenessRegistry } from "../lib/uniqueness";
import { bytesLabel, esc } from "./format";
import { cardHtml, type Item } from "./render";

const MAX_BYTES = 150 * 1024 * 1024;
const ACCEPT = /\.(step|stp|fcstd)$/i;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)"/><path d="M16 6l9 5v10l-9 5-9-5V11z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M7 11l9 5 9-5M16 16v10" fill="none" stroke="#fff" stroke-width="2"/></svg>
      <div><h1>CAD Validator</h1><p>STEP and FreeCAD checks that run in your browser</p></div></div>
    <div class="engine" id="engine" role="status" aria-live="polite"></div>
  </header>
  <main>
    <label class="drop" id="drop" for="file">
      <input id="file" type="file" accept=".step,.stp,.fcstd,.FCStd" multiple />
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
  <footer>Rules follow the Kuinbee spec as implemented in <code>validator/validate.py</code>: face count, solids, analytic surfaces, proportions, feature size, B-rep validity, gaps, STEP round-trip.</footer>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const engineEl = $("engine");
const resultsEl = $("results");

/* ---------- worker ---------- */

const worker = new Worker(new URL("../worker/worker.ts", import.meta.url), { type: "module" });
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
let ready = false;
const registry = new UniquenessRegistry();
const items: Item[] = [];
const buffers = new Map<number, ArrayBuffer>();
const sampleWaiters = new Map<number, { ok: (f: File) => void; fail: (message: string) => void }>();
let nextId = 1;
let busy = false;

function setEngine(html: string, cls = "") {
  engineEl.className = `engine ${cls}`;
  engineEl.innerHTML = html;
}
setEngine('<span class="spin"></span> Starting geometry engine…');
send({ type: "init" });

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
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
};

worker.onerror = (e) => setEngine(`Engine crashed: ${esc(e.message)}`, "bad");

/* ---------- queue ---------- */

function pump() {
  if (!ready || busy) return;
  const next = items.find((i) => i.status === "queued");
  if (!next) return;
  const buffer = buffers.get(next.id);
  if (!buffer) return;
  busy = true;
  next.status = "running";
  render();
  // Let the "Checking…" state paint first. A timer, not requestAnimationFrame: that never fires in a background tab.
  setTimeout(() => send({ type: "validate", id: next.id, name: next.name, buffer }, [buffer]), 30);
}

async function addFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    const id = nextId++;
    if (!ACCEPT.test(file.name)) {
      items.unshift({ id, name: file.name, size: file.size, status: "error", error: "Only .step, .stp and .FCStd files are supported." });
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

function render() {
  resultsEl.innerHTML = items.map(cardHtml).join("");
  const done = items.filter((i) => i.report);
  const pass = done.filter((i) => i.report!.passed).length;
  $("listHead").hidden = items.length === 0;
  $("summary").textContent = items.length
    ? `${items.length} file${items.length === 1 ? "" : "s"}${done.length ? ` · ${pass} passed · ${done.length - pass} failed` : ""}`
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
    registry.remove(it.name);
    render();
  } else if (btn.dataset.act === "json" && it.report) {
    download(`${it.name.replace(/\.[^.]+$/, "")}.validation.json`, JSON.stringify(it.report, null, 2));
  }
});

render();
