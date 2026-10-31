import { strFromU8, unzipSync, zipSync } from "fflate";
import { compareReexport, dropReexportEchoes, evaluate, isPerChildFailure } from "../lib/evaluate";
import { buildFcTree, finalShapes, parseDocumentXml } from "../lib/fcstdDoc";
import { PER_CHILD_CODES, REEXPORT_CODES } from "../lib/limits";
import { parseStepText } from "../lib/stepText";
import { signatureOf } from "../lib/uniqueness";
import type { ChildReport, Failure, FcstdInfo, Format, Measures, Report, SampleKind, Signature, TreeNode } from "../lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;
type Shape = any;

interface NativeFormat {
  ext: string;
  label: string;
  app: string;
  exportHint: string;
  container: "ole" | "zip" | "any";
}

const NATIVE: NativeFormat[] = [
  { ext: ".sldprt", label: "SolidWorks .SLDPRT", app: "SolidWorks", exportHint: "use File \u203a Save As \u203a STEP AP214 or AP242", container: "ole" },
  { ext: ".prt", label: "Siemens NX .PRT", app: "NX (or Creo)", exportHint: "use File \u203a Export \u203a STEP214 or STEP242", container: "any" },
  { ext: ".f3d", label: "Fusion .F3D", app: "Fusion", exportHint: "use File \u203a Export \u203a STEP", container: "zip" },
  { ext: ".ipt", label: "Inventor .IPT", app: "Inventor", exportHint: "use Save Copy As \u203a STEP", container: "ole" },
];

const ANALYTIC: Record<number, string> = { 0: "plane", 1: "cylinder", 2: "cone", 3: "sphere", 4: "torus" };

type Sniffed = "step" | "zip" | "ole" | "unknown";

/** What the bytes really are, whatever the extension claims. */
function sniff(b: Uint8Array): Sniffed {
  if (/^\s*ISO-10303-21/.test(new TextDecoder().decode(b.subarray(0, 64)))) return "step";
  if (b[0] === 0x50 && b[1] === 0x4b) return "zip";
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => b[i] === v)) return "ole";
  return "unknown";
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

const treeDepth = (n: TreeNode): number => (n.kind === "assembly" ? 1 + Math.max(0, ...n.children.map(treeDepth)) : 0);

/** Eigenvalues of a symmetric 3x3 matrix (closed form), ascending. */
function symmetricEigenvalues(a: number[][]): number[] {
  const p1 = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
  const q = (a[0][0] + a[1][1] + a[2][2]) / 3;
  if (p1 < 1e-30 * Math.max(1, q * q)) return [a[0][0], a[1][1], a[2][2]].sort((x, y) => x - y);
  const p2 = (a[0][0] - q) ** 2 + (a[1][1] - q) ** 2 + (a[2][2] - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b = a.map((row, i) => row.map((v, j) => (v - (i === j ? q : 0)) / p));
  const det =
    b[0][0] * (b[1][1] * b[2][2] - b[1][2] * b[2][1]) -
    b[0][1] * (b[1][0] * b[2][2] - b[1][2] * b[2][0]) +
    b[0][2] * (b[1][0] * b[2][1] - b[1][1] * b[2][0]);
  const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [e3, 3 * q - e1 - e3, e1];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ShapeCheck {
  measures: Measures;
  failures: Failure[];
  reexport: Measures | null;
}

export class Engine {
  private seq = 0;
  /** Progress hook set by the worker for the file being checked. */
  onStage: (text: string) => void = () => {};

  constructor(private oc: OC) {}

  /* ---------- OpenCASCADE plumbing ---------- */

  /**
   * Short, recycled file names. This opencascade.js build corrupts the heap once a path handed to
   * ReadFile/Write/BRepTools gets longer than about ten characters, so never let names grow.
   */
  private path(ext: string) {
    return `/${String.fromCharCode(97 + (this.seq++ % 26))}.${ext}`;
  }
  private put(path: string, bytes: Uint8Array) {
    this.oc.FS.writeFile(path, bytes);
  }
  private rm(path: string) {
    try {
      this.oc.FS.unlink(path);
    } catch {
      /* already gone */
    }
  }
  /** This OpenCASCADE build predates Message_ProgressRange; BRepTools wants a null indicator handle instead. */
  private noProgress() {
    return new this.oc.Handle_Message_ProgressIndicator_1();
  }
  private done(status: any) {
    return status.value === this.oc.IFSelect_ReturnStatus.IFSelect_RetDone.value;
  }
  private kind(name: string) {
    return this.oc.TopAbs_ShapeEnum[name];
  }

  /** Visit sub-shapes immediately: `Current()` is only valid until `Next()`. */
  private each(shape: Shape, kind: string, cb: (s: Shape, i: number) => void) {
    const oc = this.oc;
    const ex = new oc.TopExp_Explorer_2(shape, this.kind(kind), this.kind("TopAbs_SHAPE"));
    try {
      let i = 0;
      while (ex.More()) {
        cb(ex.Current(), i++);
        ex.Next();
      }
    } finally {
      ex.delete();
    }
  }

  private count(shape: Shape, kind: string) {
    let n = 0;
    this.each(shape, kind, () => n++);
    return n;
  }

  readStep(bytes: Uint8Array): Shape | null {
    const oc = this.oc;
    const path = this.path("step");
    this.put(path, bytes);
    const reader = new oc.STEPControl_Reader_1();
    try {
      if (!this.done(reader.ReadFile(path))) return null;
      if (reader.TransferRoots() === 0) return null;
      return reader.OneShape();
    } finally {
      reader.delete();
      this.rm(path);
    }
  }

  readBrep(bytes: Uint8Array): Shape | null {
    const oc = this.oc;
    const path = this.path("brp");
    this.put(path, bytes);
    const shape = new oc.TopoDS_Shape();
    const builder = new oc.BRep_Builder();
    try {
      return oc.BRepTools.Read_2(shape, path, builder, this.noProgress()) ? shape : null;
    } catch {
      return null;
    } finally {
      builder.delete();
      this.rm(path);
    }
  }

  writeStep(shape: Shape): Uint8Array | null {
    const oc = this.oc;
    const path = this.path("step");
    const writer = new oc.STEPControl_Writer_1();
    try {
      writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
      if (!this.done(writer.Write(path))) return null;
      return oc.FS.readFile(path) as Uint8Array;
    } finally {
      writer.delete();
      this.rm(path);
    }
  }

  private compound(shapes: Shape[]): Shape {
    const oc = this.oc;
    const builder = new oc.BRep_Builder();
    const comp = new oc.TopoDS_Compound();
    builder.MakeCompound(comp);
    for (const s of shapes) builder.Add(comp, s);
    builder.delete();
    return comp;
  }

  /* ---------- validate.py: measure ---------- */

  /**
   * "noarea" skips the surface integral (only the uniqueness signature needs it). "light" also skips volume and the
   * B-rep check, the slow parts: an assembly's parent takes those from its parts instead.
   */
  measure(shape: Shape, mode: "full" | "noarea" | "light" = "full"): Measures {
    const oc = this.oc;
    const faceTypes: Record<string, number> = {};
    let faces = 0;
    let smallest: { kind: string; size: number } | null = null;
    const feature = (kind: string, size: number) => {
      if (!smallest || size < smallest.size) smallest = { kind, size };
    };

    this.each(shape, "TopAbs_FACE", (cur) => {
      faces++;
      const face = oc.TopoDS.Face_1(cur);
      const surf = new oc.BRepAdaptor_Surface_2(face, true);
      try {
        const t: number = surf.GetType().value;
        const name = ANALYTIC[t] ?? "non_analytic";
        faceTypes[name] = (faceTypes[name] ?? 0) + 1;
        if (t === 1) feature("cylinder_radius", surf.Cylinder().Radius());
        else if (t === 3) feature("sphere_radius", surf.Sphere().Radius());
        else if (t === 4) feature("torus_minor_radius", surf.Torus().MinorRadius());
      } finally {
        surf.delete();
      }
    });

    const box = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(shape, box, true);
    let dims = [0, 0, 0];
    if (!box.IsVoid()) {
      const lo = box.CornerMin();
      const hi = box.CornerMax();
      dims = [hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z()].sort((a, b) => a - b);
      lo.delete();
      hi.delete();
    }
    box.delete();

    const vp = new oc.GProp_GProps_1();
    if (mode !== "light") oc.BRepGProp.VolumeProperties_1(shape, vp, false, false, false);
    const volume: number = mode === "light" ? 0 : vp.Mass();
    let moments: number[] = [0, 0, 0];
    try {
      if (mode === "light") throw new Error("not measured");
      const mat = vp.MatrixOfInertia();
      moments = symmetricEigenvalues([1, 2, 3].map((r) => [1, 2, 3].map((c) => mat.Value(r, c))));
      mat.delete();
    } catch {
      /* moments only feed the uniqueness signature */
    }
    vp.delete();

    let area = 0;
    if (mode === "full") {
      const sp = new oc.GProp_GProps_1();
      oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
      area = sp.Mass();
      sp.delete();
    }

    let freeEdges = 0;
    try {
      const fb = new oc.ShapeAnalysis_FreeBounds_2(shape, false, true, false);
      for (const wires of [fb.GetClosedWires(), fb.GetOpenWires()]) freeEdges += this.count(wires, "TopAbs_EDGE");
      fb.delete();
    } catch {
      freeEdges = -1;
    }

    let validBrep = mode === "light";
    if (mode !== "light") {
      const analyzer = new oc.BRepCheck_Analyzer(shape, true);
      try {
        validBrep = analyzer.IsValid_2();
      } finally {
        analyzer.delete();
      }
    }

    const longest = dims[2];
    return {
      solids: this.count(shape, "TopAbs_SOLID"),
      shells: this.count(shape, "TopAbs_SHELL"),
      faces,
      faceTypes,
      bboxDimsSorted: dims.map((d) => round(d, 4)),
      longest,
      aspectRatio: dims[0] > 1e-9 ? round(longest / dims[0], 3) : null,
      volume,
      area,
      validBrep,
      freeEdges,
      smallestFeature: smallest,
      moments,
    };
  }

  /** Measure, evaluate, then re-export to STEP, reopen and compare (validate.py `validate`). */
  check(shape: Shape, measured?: Measures): ShapeCheck {
    const measures = measured ?? this.measure(shape);;
    const failures = evaluate(measures);
    let reexport: Measures | null = null;
    const bytes = this.writeStep(shape);;
    if (!bytes) {
      failures.push({ code: "reexport_failed", message: "STEP re-export failed" });
    } else {
      const shape2 = this.readStep(bytes);;
      if (!shape2) {
        failures.push({ code: "reexport_reopen", message: "re-exported STEP failed to reopen" });
      } else {
        reexport = this.measure(shape2, "noarea");;
        failures.push(...compareReexport(measures, reexport));
        shape2.delete();
      }
    }
    return { measures, failures: dropReexportEchoes(failures), reexport };
  }

  /* ---------- whole-file flows ---------- */

  async validate(name: string, buffer: ArrayBuffer): Promise<Report> {
    const t0 = performance.now();
    const bytes = new Uint8Array(buffer);
    const lower = name.toLowerCase();
    const native = NATIVE.find((n) => lower.endsWith(n.ext));
    const format: Format | null = /\.(step|stp)$/.test(lower) ? "step" : lower.endsWith(".fcstd") ? "fcstd" : native ? "native" : null;
    const base: Report = {
      file: name,
      size: bytes.length,
      format: format ?? "step",
      sha256: await sha256Hex(bytes),
      parsed: false,
      passed: false,
      failures: [],
      fileClass: null,
      role: "STANDALONE",
      measures: null,
      reexport: null,
      reexportOk: null,
      children: [],
      tree: null,
      levels: 0,
      parts: 0,
      uniqueParts: 0,
      step: null,
      fcstd: null,
      signatures: [],
      notes: [],
      elapsedMs: 0,
      preview: null,
    };
    const finish = (r: Report): Report => ({ ...r, passed: r.parsed && r.failures.length === 0, elapsedMs: Math.round(performance.now() - t0) });

    if (!format) {
      return finish({ ...base, failures: [{ code: "format", message: "Supported files: .step, .stp, .FCStd (checked) and .SLDPRT, .PRT, .F3D, .IPT (identified only)." }] });
    }
    const truth = sniff(bytes);
    const ext = lower.slice(lower.lastIndexOf("."));
    // "Changing .step to .prt is only renaming" (handbook): trust the bytes, not the extension.
    if (truth === "step" && format !== "step") {
      const r = this.validateStep({ ...base, format: "step" }, bytes);
      return finish({
        ...r,
        failures: [{ code: "renamed", message: `This is a STEP exchange file saved with a ${ext} extension. Renaming does not make it native CAD and it carries no design history (class C).` }, ...r.failures],
      });
    }
    if (format === "step" && (truth === "zip" || truth === "ole")) {
      return finish({ ...base, failures: [{ code: "syntax", message: `This ${truth === "zip" ? "zip archive" : "OLE container"} is a native CAD file renamed to ${ext}. A STEP file is plain text starting with ISO-10303-21; export a real STEP from the CAD tool.` }] });
    }
    if (native) return finish(this.identifyNative(base, bytes, native));
    return finish(format === "step" ? this.validateStep(base, bytes) : this.validateFcstd(base, bytes));
  }

  /** Proprietary CAD formats cannot be read by any open browser-side kernel: identify, do not pretend to validate. */
  private identifyNative(base: Report, bytes: Uint8Array, n: NativeFormat): Report {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const container = ole ? "OLE compound file" : zip ? "zip archive" : "unrecognised container";
    const expected = n.container === "ole" ? ole : n.container === "zip" ? zip : ole || zip;
    const notes = ["A native extension does not prove the file holds original design history, and that cannot be checked here.", `Detected ${container}${expected ? ", as expected for this format" : `; ${n.label} files are normally ${n.container === "zip" ? "a zip archive" : n.container === "ole" ? "an OLE compound file" : "an OLE or zip container"}, so this file may be damaged or mislabelled`}.`];
    return {
      ...base,
      notes,
      failures: [{ code: "native", message: `${n.label} is a proprietary format whose geometry cannot be read in a browser, so none of the rules were run. In ${n.app}, ${n.exportHint}, then drop the STEP file here.` }],
    };
  }

  private validateStep(base: Report, bytes: Uint8Array): Report {
    const text = new TextDecoder("utf-8").decode(bytes);
    const structure = parseStepText(text);
    const r: Report = {
      ...base,
      fileClass: "C",
      step: structure.info,
      tree: structure.tree,
      role: structure.role,
      levels: structure.levels,
      parts: structure.parts,
      uniqueParts: structure.uniqueParts,
    };
    if (!structure.info.headerOk) {
      return { ...r, failures: [{ code: "syntax", message: "Not a valid STEP file (missing ISO-10303-21 header/footer)." }] };
    }
    const shape = this.readStep(bytes);
    if (!shape) return { ...r, failures: [{ code: "parse", message: "STEP parse failed" }] };
    try {
      if (structure.role === "PARENT") {
        const children: { name: string; shape: Shape }[] = [];
        this.each(shape, "TopAbs_SOLID", (cur, i) => {
          // Keep a handle that outlives the explorer by wrapping the solid in a one-item compound.
          children.push({ name: `Solid ${i + 1}`, shape: this.compound([cur]) });
        });
        try {
          return this.assemble({ ...r, parsed: true }, shape, children);
        } finally {
          for (const c of children) c.shape.delete();
        }
      }
      return this.assemble({ ...r, parsed: true }, shape, null);
    } finally {
      shape.delete();
    }
  }

  private validateFcstd(base: Report, bytes: Uint8Array): Report {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return { ...base, failures: [{ code: "syntax", message: "Not a valid .FCStd (a FreeCAD file is a zip archive)." }] };
    }
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      return { ...base, failures: [{ code: "syntax", message: "Zip directory not found: file is damaged." }] };
    }
    const docBytes = files["Document.xml"];
    if (!docBytes) {
      return { ...base, failures: [{ code: "syntax", message: "No Document.xml: not a FreeCAD document." }] };
    }
    const doc = parseDocumentXml(strFromU8(docBytes));
    const brepFiles = Object.keys(files).filter((f) => /\.brp$/i.test(f)).length;
    const leaves = finalShapes(doc.objects).filter((o) => o.shapeFile && files[o.shapeFile]);
    const fcstd: FcstdInfo = { ...doc.info, brepFiles, usedShapes: leaves.map((l) => l.label) };
    const notes: string[] = [];
    if (!doc.info.bodies) notes.push("No PartDesign Body: no parametric part found.");
    if (doc.info.sketches + doc.info.pads + doc.info.pockets === 0) {
      notes.push("No Sketch/Pad/Pocket features: geometry-only (class B), not original design history.");
    }
    const r: Report = { ...base, fileClass: doc.info.designClass, fcstd, notes, tree: buildFcTree(doc.objects, leaves) };

    const shapes: { name: string; shape: Shape }[] = [];
    for (const leaf of leaves) {
      const s = this.readBrep(files[leaf.shapeFile!]);
      if (s) shapes.push({ name: leaf.label, shape: s });
      else notes.push(`Could not read the stored shape of "${leaf.label}".`);
    }
    if (!shapes.length) {
      return {
        ...r,
        failures: [{ code: "parse", message: "No readable B-rep shape in this FCStd (shapes are cached as .brp files; save the model with its shapes included)." }],
      };
    }
    try {
      if (shapes.length === 1) return this.assemble({ ...r, parsed: true, parts: 1, uniqueParts: 1 }, shapes[0].shape, null);
      const whole = this.compound(shapes.map((s) => s.shape));
      try {
        return this.assemble({ ...r, parsed: true, role: "PARENT", levels: r.tree ? treeDepth(r.tree) : 1, parts: shapes.length }, whole, shapes);
      } finally {
        whole.delete();
      }
    } finally {
      for (const s of shapes) s.shape.delete();
    }
  }

  /** Shared tail: whole-file check, then per-child checks for assemblies. */
  private assemble(r: Report, whole: Shape, children: { name: string; shape: Shape }[] | null): Report {
    if (!children) {
      this.onStage("Checking the whole model\u2026");
      const overall = this.check(whole);
      const sig = signatureOf(overall.measures);
      let out: Report = { ...r, measures: overall.measures, reexport: overall.reexport };
      const failures = overall.failures;
      out = { ...out, failures, reexportOk: this.reexportOk(failures, overall.reexport) };
      if (sig) out.signatures = [{ label: r.file, signature: sig }];
      return this.withPreview(out, whole);
    }

    // Spec rules apply to every child; the parent file itself must be a valid, closed, re-exportable B-rep.
    const grouped = new Map<string, ChildReport>();
    for (const [i, c] of children.entries()) {
      this.onStage(`Checking part ${i + 1} of ${children.length}\u2026`);
      const m = this.measure(c.shape);
      const key = [m.faces, round(m.volume, 3), m.bboxDimsSorted.join("x")].join("|");
      const seen = grouped.get(key);
      if (seen) {
        seen.count++;
        continue;
      }
      const chk = this.check(c.shape, m);
      grouped.set(key, {
        name: c.name,
        count: 1,
        measures: chk.measures,
        failures: chk.failures,
        passed: chk.failures.length === 0,
        signature: signatureOf(chk.measures),
      });
    }
    const kids = [...grouped.values()];

    // A compound is valid when every part is, and its volume and area are the parts' sums, so the whole-model
    // pass only measures what the parts cannot tell: counts, bounding box and free edges.
    this.onStage("Checking the whole model\u2026");
    const light = this.measure(whole, "light");
    const sum = (pick: (m: Measures) => number) => kids.reduce((t, k) => t + pick(k.measures) * k.count, 0);
    const measures: Measures = {
      ...light,
      volume: sum((m) => m.volume),
      area: sum((m) => m.area),
      validBrep: kids.every((k) => k.measures.validBrep),
    };
    const overall = this.check(whole, measures);
    let out: Report = { ...r, measures: overall.measures, reexport: overall.reexport };
    const parentFails = overall.failures.filter((f) => !isPerChildFailure(f, PER_CHILD_CODES));
    const failures = [...parentFails, ...kids.flatMap((k) => k.failures.map((f) => ({ code: `child:${f.code}`, message: `child ${k.name}: ${f.message}` })))];
    out = {
      ...out,
      role: "PARENT",
      children: kids,
      failures,
      reexportOk: this.reexportOk(parentFails, overall.reexport),
      uniqueParts: kids.length,
      parts: Math.max(out.parts, children.length),
      levels: Math.max(out.levels, 1),
      signatures: kids.filter((k) => k.signature).map((k) => ({ label: k.name, signature: k.signature as Signature })),
    };
    if (!out.tree) out.tree = this.flatTree(r.file, kids);
    return this.withPreview(out, whole);
  }

  /** Tessellate last: meshing adds triangulation to the shape, which would perturb the measurements above. */
  private withPreview(out: Report, whole: Shape): Report {
    this.onStage("Building the 3D view\u2026");
    try {
      return { ...out, preview: this.tessellate(whole, out.measures?.longest ?? 0) };
    } catch {
      return { ...out, notes: [...out.notes, "The 3D view could not be built for this file."] };
    }
  }

  /** Triangle soup read straight from each face's triangulation (the STL writer in this build writes nothing). */
  private tessellate(shape: Shape, longest: number): Float32Array | null {
    const oc = this.oc;
    const defl = Math.max(longest * 0.003, 1e-4);
    new oc.BRepMesh_IncrementalMesh_2(shape, defl, false, 0.6, false).delete();
    const out: number[] = [];
    this.each(shape, "TopAbs_FACE", (cur) => {
      const face = oc.TopoDS.Face_1(cur);
      const loc = new oc.TopLoc_Location_1();
      const handle = oc.BRep_Tool.Triangulation(face, loc);
      if (handle.IsNull()) return;
      const tri = handle.get();
      const trsf = loc.Transformation();
      const flip = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      const pts: number[][] = [];
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = tri.Node(i).Transformed(trsf);
        pts.push([p.X(), p.Y(), p.Z()]);
        p.delete();
      }
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = tri.Triangle(i);
        const order = flip ? [1, 3, 2] : [1, 2, 3];
        for (const k of order) out.push(...pts[t.Value(k) - 1]);
      }
      loc.delete();
    });
    return out.length ? Float32Array.from(out) : null;
  }

  private reexportOk(fails: Failure[], reexport: Measures | null) {
    return reexport !== null && !fails.some((f) => REEXPORT_CODES.includes(f.code));
  }

  private flatTree(name: string, kids: ChildReport[]): TreeNode {
    return {
      name: name.replace(/\.[^.]+$/, ""),
      kind: "assembly",
      count: 1,
      faces: 0,
      solids: 0,
      children: kids.map((k) => ({ name: k.name, kind: "part", count: k.count, faces: k.measures.faces, solids: k.measures.solids, children: [] })),
    };
  }

  /* ---------- sample files (so the app can be tried without a CAD file) ---------- */

  private pnt(x: number, y: number, z: number) {
    return new this.oc.gp_Pnt_3(x, y, z);
  }
  private axis(x: number, y: number, z: number) {
    const oc = this.oc;
    return new oc.gp_Ax2_3(this.pnt(x, y, z), new oc.gp_Dir_4(0, 0, 1));
  }
  private cylinder(x: number, y: number, z: number, r: number, h: number): Shape {
    const mk = new this.oc.BRepPrimAPI_MakeCylinder_3(this.axis(x, y, z), r, h);
    return mk.Shape();
  }
  private box(dx: number, dy: number, dz: number): Shape {
    return new this.oc.BRepPrimAPI_MakeBox_1(dx, dy, dz).Shape();
  }
  private cut(a: Shape, b: Shape): Shape {
    return new this.oc.BRepAlgoAPI_Cut_3(a, b).Shape();
  }

  private flange(): Shape {
    let s = this.cylinder(0, 0, 0, 40, 10);
    s = this.cut(s, this.cylinder(0, 0, -1, 10, 12));
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      s = this.cut(s, this.cylinder(25 * Math.cos(a), 25 * Math.sin(a), -1, 4, 12));
    }
    return s;
  }

  private strip(): Shape {
    let s = this.box(200, 40, 5);
    for (let i = 0; i < 4; i++) s = this.cut(s, this.cylinder(30 + i * 45, 20, -1, 6, 7));
    return s;
  }

  sample(kind: SampleKind): { name: string; bytes: Uint8Array } {
    const make = (name: string, shape: Shape) => {
      // No shape.delete() here: `.Shape()` hands back a view into the maker object, so freeing it corrupts the heap.
      const bytes = this.writeStep(shape);
      if (!bytes) throw new Error("sample export failed");
      return { name, bytes };
    };
    if (kind === "flange") return make("sample_flange_pass.step", this.flange());
    if (kind === "strip") return make("sample_thin_strip_fails_aspect.step", this.strip());
    if (kind === "cube") return make("sample_cube_fails_face_count.step", this.box(20, 20, 20));
    if (kind === "fcstd") {
      const oc = this.oc;
      const brp = (shape: Shape) => {
        const path = this.path("brp");
        oc.BRepTools.Write_2(shape, path, this.noProgress());
        const out = oc.FS.readFile(path) as Uint8Array;
        this.rm(path);
        return out;
      };
      const xml = `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="4" ProgramVersion="1.0.0">
<Objects Count="3">
<Object type="App::Part" name="Part" id="1"/>
<Object type="PartDesign::Body" name="Body" id="2"/>
<Object type="PartDesign::Body" name="Body001" id="3"/>
</Objects>
<ObjectData Count="3">
<Object name="Part"><Properties Count="2">
<Property name="Group" type="App::PropertyLinkList"><LinkList count="2"><Link value="Body"/><Link value="Body001"/></LinkList></Property>
<Property name="Label" type="App::PropertyString"><String value="Sample assembly"/></Property>
</Properties></Object>
<Object name="Body"><Properties Count="2">
<Property name="Label" type="App::PropertyString"><String value="Flange"/></Property>
<Property name="Shape" type="Part::PropertyPartShape"><Part file="PartShape.brp"/></Property>
</Properties></Object>
<Object name="Body001"><Properties Count="2">
<Property name="Label" type="App::PropertyString"><String value="Strip"/></Property>
<Property name="Shape" type="Part::PropertyPartShape"><Part file="PartShape1.brp"/></Property>
</Properties></Object>
</ObjectData>
</Document>`;
      const zip = zipSync({
        "Document.xml": new TextEncoder().encode(xml),
        "PartShape.brp": brp(this.flange()),
        "PartShape1.brp": brp(this.strip()),
      });
      return { name: "sample_assembly.FCStd", bytes: zip };
    }
    throw new Error(`unknown sample: ${String(kind)}`);
  }
}
