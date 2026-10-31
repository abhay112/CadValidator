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

const ANALYTIC: Record<number, string> = { 0: "plane", 1: "cylinder", 2: "cone", 3: "sphere", 4: "torus" };

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

  measure(shape: Shape): Measures {
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
    oc.BRepGProp.VolumeProperties_1(shape, vp, false, false, false);
    const volume: number = vp.Mass();
    let moments: number[] = [0, 0, 0];
    try {
      const mat = vp.MatrixOfInertia();
      moments = symmetricEigenvalues([1, 2, 3].map((r) => [1, 2, 3].map((c) => mat.Value(r, c))));
      mat.delete();
    } catch {
      /* moments only feed the uniqueness signature */
    }
    vp.delete();

    const sp = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
    const area: number = sp.Mass();
    sp.delete();

    let freeEdges = 0;
    try {
      const fb = new oc.ShapeAnalysis_FreeBounds_2(shape, false, true, false);
      for (const wires of [fb.GetClosedWires(), fb.GetOpenWires()]) freeEdges += this.count(wires, "TopAbs_EDGE");
      fb.delete();
    } catch {
      freeEdges = -1;
    }

    let validBrep = false;
    const analyzer = new oc.BRepCheck_Analyzer(shape, true);
    try {
      validBrep = analyzer.IsValid_2();
    } finally {
      analyzer.delete();
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
  check(shape: Shape): ShapeCheck {
    const measures = this.measure(shape);
    const failures = evaluate(measures);
    let reexport: Measures | null = null;
    const bytes = this.writeStep(shape);
    if (!bytes) {
      failures.push({ code: "reexport_failed", message: "STEP re-export failed" });
    } else {
      const shape2 = this.readStep(bytes);
      if (!shape2) {
        failures.push({ code: "reexport_reopen", message: "re-exported STEP failed to reopen" });
      } else {
        reexport = this.measure(shape2);
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
    const format: Format | null = /\.(step|stp)$/.test(lower) ? "step" : lower.endsWith(".fcstd") ? "fcstd" : null;
    const base: Report = {
      file: name,
      size: bytes.length,
      format: format ?? "step",
      sha256: await sha256Hex(bytes),
      parsed: false,
      passed: false,
      failures: [],
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
    };
    const finish = (r: Report): Report => ({ ...r, passed: r.parsed && r.failures.length === 0, elapsedMs: Math.round(performance.now() - t0) });

    if (!format) {
      return finish({ ...base, failures: [{ code: "format", message: "Only .step, .stp and .FCStd files are supported." }] });
    }
    return finish(format === "step" ? this.validateStep(base, bytes) : this.validateFcstd(base, bytes));
  }

  private validateStep(base: Report, bytes: Uint8Array): Report {
    const text = new TextDecoder("utf-8").decode(bytes);
    const structure = parseStepText(text);
    const r: Report = {
      ...base,
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
    const r: Report = { ...base, fcstd, notes, tree: buildFcTree(doc.objects, leaves) };

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
    const overall = this.check(whole);
    const sig = signatureOf(overall.measures);
    let out: Report = { ...r, measures: overall.measures, reexport: overall.reexport };

    if (!children) {
      const failures = overall.failures;
      out = { ...out, failures, reexportOk: this.reexportOk(failures, overall.reexport) };
      if (sig) out.signatures = [{ label: r.file, signature: sig }];
      return out;
    }

    // Spec rules apply to every child; the parent file itself must be a valid, closed, re-exportable B-rep.
    const grouped = new Map<string, ChildReport>();
    for (const c of children) {
      const m = this.measure(c.shape);
      const key = [m.faces, round(m.volume, 3), m.bboxDimsSorted.join("x")].join("|");
      const seen = grouped.get(key);
      if (seen) {
        seen.count++;
        continue;
      }
      const chk = this.check(c.shape);
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
    return out;
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
