import { RULES, MAX_ASPECT, MAX_FACES, MAX_SOLIDS, MIN_FACES, MIN_FEATURE_FRACTION, PER_CHILD_CODES, REEXPORT_CODES } from "../lib/limits";
import type { ChildReport, Failure, Measures, Report, TreeNode } from "../lib/types";
import type { Match } from "../lib/uniqueness";
import { bytesLabel, esc, fmt } from "./format";

export interface Item {
  id: number;
  name: string;
  size: number;
  status: "queued" | "running" | "done" | "error";
  report?: Report;
  error?: string;
  matches?: Match[];
  comparedWith?: number;
  stage?: string;
}

const AFTER = "after_reexport:";
const isRoundTrip = (f: Failure) => REEXPORT_CODES.includes(f.code);
/** After de-duplication in the engine, any remaining "after re-export: X" is a problem the round-trip introduced. */
const reexportIssues = (fails: Failure[]) => fails.filter((f) => isRoundTrip(f) || f.code.startsWith(AFTER));
const hits = (fails: Failure[], code: string) => (code === "reexport" ? reexportIssues(fails).length > 0 : fails.some((f) => f.code === code));

function measured(code: string, m: Measures, fails: Failure[]): string {
  switch (code) {
    case "no_solid":
    case "too_many_solids":
      return `${m.solids} solid${m.solids === 1 ? "" : "s"}`;
    case "face_range":
      return `${m.faces} faces`;
    case "non_analytic": {
      const types = Object.entries(m.faceTypes).map(([k, v]) => `${k.replace("_", "-")} ${v}`);
      return types.join(" · ") || "—";
    }
    case "aspect":
      return m.aspectRatio === null ? "degenerate box" : `${fmt(m.aspectRatio)} : 1`;
    case "small_feature": {
      const sf = m.smallestFeature;
      if (!sf) return "no radii found";
      return `${sf.kind.replace(/_/g, " ")} ${fmt(sf.size)} (${fmt((sf.size / m.longest) * 100, 1)}%)`;
    }
    case "cavity":
      return m.shells > m.solids ? `${m.shells - m.solids} void shell(s)` : "none";
    case "invalid_brep":
      return m.validBrep ? "valid" : "invalid";
    case "free_edges":
      return m.freeEdges < 0 ? "could not analyse" : `${m.freeEdges} free edges`;
    case "volume":
      return fmt(m.volume);
    case "reexport":
      return reexportIssues(fails).length ? reexportIssues(fails).map((f) => f.message.replace(/^after re-export: /, "")).join("; ") : "round-trip identical";
    default:
      return "";
  }
}

function checksTable(r: Report): string {
  const m = r.measures;
  if (!m) return "";
  const parent = r.role === "PARENT";
  const wholeFails = parent ? r.failures.filter((f) => !f.code.startsWith("child:")) : r.failures;
  const rows = RULES.map((rule) => {
    let ok: boolean;
    let value: string;
    let note = "";
    if (parent && PER_CHILD_CODES.has(rule.code)) {
      const bad = r.children.filter((c) => hits(c.failures, rule.code));
      ok = bad.length === 0;
      value = `${r.children.length - bad.length} of ${r.children.length} parts OK`;
      if (bad.length) note = bad.map((c) => `${c.name}: ${c.failures.filter((f) => hits([f], rule.code)).map((f) => f.message).join("; ")}`).join("\n");
    } else {
      ok = !hits(wholeFails, rule.code);
      value = measured(rule.code, m, wholeFails);
    }
    const scope = parent && PER_CHILD_CODES.has(rule.code) ? '<span class="scope">each part</span>' : "";
    return `<tr class="${ok ? "ok" : "bad"}">
      <td class="st"><span class="dot ${ok ? "pass" : "fail"}" role="img" aria-label="${ok ? "pass" : "fail"}">${ok ? "✓" : "✕"}</span></td>
      <td><strong>${esc(rule.title)}</strong>${scope}<div class="req">${esc(rule.requirement)}</div></td>
      <td class="val">${esc(value)}${note ? `<div class="note">${esc(note).replace(/\n/g, "<br>")}</div>` : ""}</td></tr>`;
  });
  return `<table class="checks"><thead><tr><th></th><th>Rule</th><th>Measured</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function measurements(r: Report): string {
  const m = r.measures;
  if (!m) return "";
  const cell = (label: string, value: string, sub = "") =>
    `<div class="metric"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
  const types = Object.entries(m.faceTypes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="chip ${k === "non_analytic" ? "warn" : ""}">${esc(k.replace("_", "-"))} <b>${v}</b></span>`)
    .join("");
  return `<div class="metrics">
    ${cell("Bounding box", m.bboxDimsSorted.map((d) => fmt(d, 2)).join(" × "), "sorted, model units (mm)")}
    ${cell("Volume", fmt(m.volume, 2))}
    ${cell("Surface area", fmt(m.area, 2))}
    ${cell("Faces", String(m.faces), `${m.solids} solid${m.solids === 1 ? "" : "s"} · ${m.shells} shell${m.shells === 1 ? "" : "s"}`)}
  </div><div class="chips" aria-label="Face types">${types}</div>`;
}

function treeHtml(n: TreeNode, root = true): string {
  const role = n.kind === "assembly" ? (root ? "PARENT" : "SUB-ASSEMBLY") : "CHILD";
  const meta = [n.count > 1 ? `×${n.count}` : "", n.faces ? `${n.faces} faces` : "", n.solids ? `${n.solids} solid${n.solids === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const kids = n.children.length ? `<ul>${n.children.map((c) => treeHtml(c, false)).join("")}</ul>` : "";
  return `<li><span class="node"><span class="role ${n.kind}">${role}</span> <span class="nm">${esc(n.name)}</span> <span class="meta">${esc(meta)}</span></span>${kids}</li>`;
}

function childrenTable(children: ChildReport[]): string {
  if (!children.length) return "";
  const rows = children
    .map(
      (c) => `<tr><td>${esc(c.name)}${c.count > 1 ? ` <span class="meta">×${c.count}</span>` : ""}</td>
      <td>${c.measures.faces}</td><td>${fmt(c.measures.aspectRatio)}</td><td>${fmt(c.measures.volume, 2)}</td>
      <td><span class="badge ${c.passed ? "pass" : "fail"}">${c.passed ? "PASS" : "FAIL"}</span>${c.failures.length ? `<div class="note">${c.failures.map((f) => esc(f.message)).join("<br>")}</div>` : ""}</td></tr>`,
    )
    .join("");
  return `<table class="plain"><thead><tr><th>Part</th><th>Faces</th><th>Aspect</th><th>Volume</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function fileInfo(r: Report, it: Item): string {
  const row = (k: string, v: string) => `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const out: string[] = [row("SHA-256", `<code class="hash">${esc(r.sha256)}</code>`), row("Checked in", `${r.elapsedMs} ms`)];
  if (r.step) {
    const s = r.step;
    out.push(
      row("Schema", esc(s.schema ?? "—")),
      row("Exported by", esc(s.originatingSystem ?? "—")),
      row("Units", esc(s.units ? `${s.units}${s.units === "mm" ? "" : " (converted to mm for the checks)"}` : "not declared (assumed mm)")),
      row("STEP entities", esc(`${s.counts.solids} solid B-rep · ${s.counts.faces} advanced faces · ${s.counts.products} products · ${s.counts.assemblyLinks} assembly links`)),
    );
  }
  if (r.fcstd) {
    const f = r.fcstd;
    out.push(
      row("Design history", `<span class="badge ${f.designClass === "A" ? "pass" : "warn"}">Class ${f.designClass}</span> ${f.designClass === "A" ? "parametric PartDesign history present" : "geometry only"}`),
      row("FreeCAD objects", esc(`${f.objects} total · ${f.bodies} bodies · ${f.parts} parts · ${f.sketches} sketches · ${f.pads} pads · ${f.pockets} pockets · ${f.dressUps} fillets/chamfers`)),
      row("Stored shapes", esc(`${f.brepFiles} B-rep file${f.brepFiles === 1 ? "" : "s"} · validated: ${f.usedShapes.join(", ") || "none"}`)),
      row("Written by", esc(f.programVersion ? `FreeCAD ${f.programVersion}` : "—")),
    );
  }
  const uniq = it.matches?.length
    ? it.matches.map((x) => `<div><span class="badge warn">${esc(x.kind)}</span> ${esc(x.label)} matches ${esc(x.of)} <span class="meta">(distance ${x.distance.toFixed(4)})</span></div>`).join("")
    : it.comparedWith
      ? `unique among the ${it.comparedWith} other model${it.comparedWith === 1 ? "" : "s"} checked this session`
      : "nothing else checked yet this session";
  out.push(row("Uniqueness", `${uniq}<div class="meta">Compared only with files in this tab; nothing is stored.</div>`));
  for (const n of r.notes) out.push(row("Note", esc(n)));
  return `<dl class="kvs">${out.join("")}</dl>`;
}

export function cardHtml(it: Item): string {
  const r = it.report;
  const ext = it.name.split(".").pop()?.toUpperCase() ?? "";
  const unchecked = r?.format === "native";
  const status =
    it.status === "done" && r && unchecked
      ? `<span class="badge big warn">NOT CHECKED</span>`
      : it.status === "done" && r
      ? `<span class="badge big ${r.passed ? "pass" : "fail"}">${r.passed ? "PASS" : "FAIL"}</span>`
      : it.status === "error"
        ? `<span class="badge big fail">ERROR</span>`
        : `<span class="badge big wait">${it.status === "running" ? esc(it.stage ?? "Checking…") : "Queued"}</span>`;
  const head = `<header class="card-head">
    <div class="ftype" aria-hidden="true">${esc(ext.slice(0, 5))}</div>
    <div class="fname"><div class="n" title="${esc(it.name)}">${esc(it.name)}</div><div class="m">${bytesLabel(it.size)}${r?.role === "PARENT" ? " · assembly" : ""}${r?.fileClass ? ` · class ${r.fileClass} ${({ A: "native parametric", B: "native geometry-only", C: "STEP exchange" } as const)[r.fileClass]}` : ""}</div></div>
    ${status}
    <div class="acts">
      ${r ? `<button class="ghost" data-act="json" data-id="${it.id}" title="Download JSON report">JSON</button>` : ""}
      <button class="ghost" data-act="remove" data-id="${it.id}" aria-label="Remove ${esc(it.name)}" title="Remove">✕</button>
    </div></header>`;

  if (it.status === "error") return `<article class="card">${head}<div class="banner fail">${esc(it.error ?? "Validation failed.")}</div></article>`;
  if (!r) return `<article class="card">${head}${it.status === "running" ? '<div class="bar"><i></i></div>' : ""}</article>`;

  const hard = r.failures.filter((f) => ["format", "syntax", "parse", "native"].includes(f.code));
  if (!r.parsed || hard.length) {
    return `<article class="card">${head}<div class="banner ${unchecked ? "warn" : "fail"}">${hard.map((f) => esc(f.message)).join("<br>") || "File could not be read."}</div>${fileInfo(r, it)}</article>`;
  }

  const shown = r.failures;
  const summary = r.passed
    ? `<div class="banner pass">All checks passed${r.role === "PARENT" ? ` for the parent and each of its ${r.children.length} unique part${r.children.length === 1 ? "" : "s"}` : ""}.</div>`
    : `<div class="banner fail"><b>${shown.length} issue${shown.length === 1 ? "" : "s"} found</b><ul>${shown.map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul></div>`;

  const assembly =
    r.role === "PARENT"
      ? `<section><h3>Assembly structure <span class="meta">${r.parts} part${r.parts === 1 ? "" : "s"} · ${r.uniqueParts} unique · ${r.levels} level${r.levels === 1 ? "" : "s"}</span></h3>
         ${r.tree ? `<ul class="tree root">${treeHtml(r.tree)}</ul>` : ""}${childrenTable(r.children)}</section>`
      : "";

  const view = r.preview
    ? `<section><h3>3D model <span class="meta">${fmt(r.preview.length / 9, 0)} triangles · drag to rotate, scroll to zoom, right-drag to pan <button class="ghost" data-act="reset" data-id="${it.id}">Reset view</button></span></h3><div class="viewer-slot" data-id="${it.id}"></div></section>`
    : "";
  return `<article class="card">${head}${summary}${view}
    <section><h3>Checks <span class="meta">${r.role === "PARENT" ? "assembly: geometry rules apply to each part" : `${MIN_FACES}–${MAX_FACES} faces · ≤${MAX_SOLIDS} solids · aspect ≤${MAX_ASPECT} · features ≥${MIN_FEATURE_FRACTION * 100}%`}</span></h3>${checksTable(r)}</section>
    ${assembly}
    <section><h3>Measurements${r.role === "PARENT" ? ' <span class="meta">whole assembly</span>' : ""}</h3>${measurements(r)}</section>
    <details class="more"><summary>File details</summary>${fileInfo(r, it)}</details>
  </article>`;
}
