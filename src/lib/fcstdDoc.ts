import type { FcstdInfo, TreeNode } from "./types";

export interface FcObject {
  name: string;
  type: string;
  label: string;
  /** Zip entry holding this object's B-rep (`*.brp`), if any. */
  shapeFile: string | null;
  group: string[];
  /** Objects this one is built from (booleans, extrusions, ...). */
  inputs: string[];
}

export interface FcDocument {
  info: Omit<FcstdInfo, "brepFiles" | "usedShapes">;
  objects: FcObject[];
}

const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Link properties that mean "this object is built from that one".
const INPUT_PROPS = new Set(["Base", "Tool", "Shapes", "Source", "Sections", "Profile", "Spine", "Objects", "Features", "Shape1", "Shape2"]);

/** Parse FreeCAD's Document.xml with regexes (DOMParser is not available in workers). */
export function parseDocumentXml(xml: string): FcDocument {
  const dataAt = xml.indexOf("<ObjectData");
  const head = dataAt > 0 ? xml.slice(0, dataAt) : xml;
  const data = dataAt > 0 ? xml.slice(dataAt) : "";

  const types = new Map<string, string>();
  for (const m of head.matchAll(/<Object\s+([^>]*?)\/?>/g)) {
    const name = attr(m[1], "name");
    const type = attr(m[1], "type");
    if (name && type) types.set(name, type);
  }

  const objects: FcObject[] = [];
  for (const m of data.matchAll(/<Object\s+([^>]*?)>([\s\S]*?)<\/Object>/g)) {
    const name = attr(m[1], "name");
    if (!name) continue;
    const body = m[2];
    let label = name;
    let shapeFile: string | null = null;
    let group: string[] = [];
    const inputs: string[] = [];
    for (const p of body.matchAll(/<Property\s+([^>]*?)>([\s\S]*?)<\/Property>/g)) {
      const pname = attr(p[1], "name");
      const ptype = attr(p[1], "type") ?? "";
      if (pname === "Label") label = unescapeXml(attr(p[2], "value") ?? name);
      else if (pname === "Shape" && ptype.includes("PartShape")) shapeFile = /<Part\b[^>]*\bfile="([^"]+)"/.exec(p[2])?.[1] ?? null;
      else if (pname === "Group") group = [...p[2].matchAll(/<Link\s+value="([^"]+)"/g)].map((x) => x[1]);
      else if (pname && INPUT_PROPS.has(pname)) {
        for (const l of p[2].matchAll(/<Link(?:Sub)?\s+(?:obj=")?value="([^"]+)"/g)) inputs.push(l[1]);
      }
    }
    objects.push({ name, type: types.get(name) ?? "", label, shapeFile, group, inputs });
  }
  // Objects listed only in the header (no ObjectData block) still count towards the totals.
  for (const [name, type] of types) {
    if (!objects.some((o) => o.name === name)) objects.push({ name, type, label: name, shapeFile: null, group: [], inputs: [] });
  }

  const n = (re: RegExp) => objects.filter((o) => re.test(o.type)).length;
  const sketches = n(/^Sketcher::SketchObject$/);
  const pads = n(/^PartDesign::Pad$/);
  const pockets = n(/^PartDesign::Pocket$/);
  const bodies = n(/^PartDesign::Body$/);
  return {
    info: {
      objects: objects.length,
      bodies,
      parts: n(/^App::Part$/),
      sketches,
      pads,
      pockets,
      dressUps: n(/^PartDesign::(Chamfer|Fillet)$/),
      designClass: bodies > 0 && sketches + pads + pockets > 0 ? "A" : "B",
      programVersion: /ProgramVersion="([^"]*)"/.exec(head)?.[1] ?? null,
    },
    objects,
  };
}

/** Objects whose shape is a finished part: Bodies, or standalone Part features nothing else consumes. */
export function finalShapes(objects: FcObject[]): FcObject[] {
  const withShape = objects.filter((o) => o.shapeFile);
  const bodies = withShape.filter((o) => o.type === "PartDesign::Body");
  if (bodies.length) return bodies;
  const consumed = new Set(withShape.flatMap((o) => o.inputs));
  return withShape.filter((o) => !consumed.has(o.name) && !/^(Sketcher|PartDesign)::/.test(o.type));
}

const HIDDEN = /^(App::(Origin|Line|Plane|Placement)|Sketcher::|PartDesign::(?!Body$))/;

/** Model tree: App::Part groups containing Bodies / shapes. Null when the document has a single shape. */
export function buildFcTree(objects: FcObject[], leaves: FcObject[]): TreeNode | null {
  const byName = new Map(objects.map((o) => [o.name, o]));
  const leafNames = new Set(leaves.map((l) => l.name));
  const nodeOf = (o: FcObject, seen: Set<string>): TreeNode | null => {
    if (leafNames.has(o.name) || (o.shapeFile && !o.group.length)) {
      return { name: o.label, kind: "part", count: 1, faces: 0, solids: 0, children: [] };
    }
    if (seen.has(o.name)) return null;
    const next = new Set(seen).add(o.name);
    const kids = o.group
      .map((g) => byName.get(g))
      .filter((c): c is FcObject => !!c && !HIDDEN.test(c.type))
      .map((c) => nodeOf(c, next))
      .filter((c): c is TreeNode => !!c);
    if (!kids.length) return null;
    return { name: o.label, kind: "assembly", count: 1, faces: 0, solids: 0, children: kids };
  };
  const grouped = new Set(objects.flatMap((o) => o.group));
  const roots = objects
    .filter((o) => !grouped.has(o.name) && !HIDDEN.test(o.type))
    .map((o) => nodeOf(o, new Set()))
    .filter((n): n is TreeNode => !!n);
  if (!roots.length) return null;
  const tree = roots.length === 1 ? roots[0] : { name: "(root)", kind: "assembly" as const, count: 1, faces: 0, solids: 0, children: roots };
  return tree.kind === "part" ? null : tree;
}
