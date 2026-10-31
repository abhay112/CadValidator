import initOpenCascade from "opencascade.js/dist/opencascade.wasm.js";
import wasmUrl from "opencascade.js/dist/opencascade.wasm.wasm?url";
import type { FromWorker, KidEntry, ToWorker } from "../lib/types";
import { Engine } from "./engine";

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

/** Decoded size of opencascade.js@1.1.1's WASM, for a sensible progress bar. */
const WASM_BYTES = 65_864_037;

let engine: Engine | null = null;
let kidWaiter: ((entries: KidEntry[] | null) => void) | null = null;
let booting: Promise<void> | null = null;

/** Stream the WASM binary ourselves so the UI can show download progress. */
async function fetchWasm(): Promise<ArrayBuffer> {
  const res = await fetch(wasmUrl);
  if (!res.ok || !res.body) throw new Error(`Could not download the geometry engine (HTTP ${res.status}).`);
  // Content-Length is the compressed size when the host gzips/brotlis the file; progress counts decoded bytes.
  const total = res.headers.get("Content-Encoding") ? WASM_BYTES : Number(res.headers.get("Content-Length") ?? 0) || WASM_BYTES;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    post({ type: "progress", loaded, total });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

function boot(): Promise<void> {
  booting ??= (async () => {
    try {
      const wasmBinary = await fetchWasm();
      const oc = await new initOpenCascade({ wasmBinary });
      engine = new Engine(oc);
      post({ type: "ready" });
    } catch (e) {
      booting = null;
      post({ type: "initError", message: e instanceof Error ? e.message : String(e) });
    }
  })();
  return booting;
}

/** OpenCASCADE throws raw pointers/numbers for C++ exceptions; make them readable. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "number" ? "The geometry kernel rejected this file (internal error)." : String(e);
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    void boot();
    return;
  }
  if (!engine) {
    post({ type: "error", id: msg.id, message: "The geometry engine is still loading." });
    return;
  }
  try {
    if (msg.type === "kids") {
      const waiting = kidWaiter;
      kidWaiter = null;
      waiting?.(msg.entries);
    } else if (msg.type === "prep") {
      post({ type: "prepared", id: msg.id, count: engine.prepare(new Uint8Array(msg.buffer), msg.kind) });
    } else if (msg.type === "job") {
      post({ type: "entry", id: msg.id, entry: engine.runJob(msg.index) });
    } else if (msg.type === "validate") {
      engine.onStage = (text) => post({ type: "stage", id: msg.id, text });
      engine.requestKids = (count, kind, source) =>
        new Promise((resolve) => {
          kidWaiter = resolve;
          // The page hands this copy to helper workers; the original stays here for the whole-model passes.
          const buffer = source.slice().buffer as ArrayBuffer;
          post({ type: "needKids", id: msg.id, count, kind, buffer }, [buffer]);
        });
      post({ type: "result", id: msg.id, report: await engine.validate(msg.name, msg.buffer) });
    } else if (msg.type === "sample") {
      const s = engine.sample(msg.kind);
      const buffer = s.bytes.buffer.slice(s.bytes.byteOffset, s.bytes.byteOffset + s.bytes.byteLength) as ArrayBuffer;
      post({ type: "sample", id: msg.id, name: s.name, buffer }, [buffer]);
    }
  } catch (e) {
    post({ type: "error", id: msg.id, message: describe(e) });
  }
};
