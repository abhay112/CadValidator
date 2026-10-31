import type { StepInfo, TreeNode } from "./types";

export interface StepStructure {
  info: StepInfo;
  tree: TreeNode | null;
  role: "STANDALONE" | "PARENT";
  levels: number;
  parts: number;
  uniqueParts: number;
}

const NEEDED = new Set([
  "PRODUCT",
  "PRODUCT_DEFINITION",
  "PRODUCT_DEFINITION_FORMATION",
  "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE",
  "NEXT_ASSEMBLY_USAGE_OCCURRENCE",
  "PRODUCT_DEFINITION_SHAPE",
  "SHAPE_DEFINITION_REPRESENTATION",
  "SHAPE_REPRESENTATION",
  "ADVANCED_BREP_SHAPE_REPRESENTATION",
  "MANIFOLD_SOLID_BREP",
  "BREP_WITH_VOIDS",
  "CLOSED_SHELL",
]);

/** Index of `matching ')'` for the '(' that ends at `from`, honouring STEP's single-quoted strings. */
function closeParen(text: string, from: number): number {
  let depth = 1;
  let inStr = false;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 39) inStr = !inStr;
    else if (!inStr) {
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) return i;
    }
  }
  return text.length;
}

function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args.charCodeAt(i);
    if (c === 39) inStr = !inStr;
    else if (!inStr) {
      if (c === 40) depth++;
      else if (c === 41) depth--;
      else if (c === 44 && depth === 0) {
        out.push(args.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  out.push(args.slice(start).trim());
  return out;
}

const unquote = (s: string | undefined) => (s ?? "").replace(/^'|'$/g, "").replace(/''/g, "'").trim();
const refOf = (s: string | undefined) => {
  const m = /^#(\d+)$/.exec((s ?? "").trim());
  return m ? Number(m[1]) : null;
};
const refsIn = (s: string | undefined) => [...(s ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

function headerField(header: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*\\(([\\s\\S]*?)\\)\\s*;`).exec(header);
  if (!m) return null;
  const parts = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function detectUnits(data: string): string | null {
  if (/CONVERSION_BASED_UNIT\s*\(\s*'(?:INCH|inch)/i.test(data)) return "inch";
  const si = /LENGTH_UNIT\s*\(\s*\)[\s\S]{0,120}?SI_UNIT\s*\(\s*(\.\w+\.|\$)\s*,\s*\.METRE\./.exec(data) ?? /SI_UNIT\s*\(\s*(\.\w+\.|\$)\s*,\s*\.METRE\./.exec(data);
  if (!si) return null;
  return ({ ".MILLI.": "mm", ".CENTI.": "cm", ".KILO.": "km", $: "m" } as Record<string, string>)[si[1].toUpperCase()] ?? si[1];
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

export function parseStepText(text: string): StepStructure {
  const headerOk = /^\s*ISO-10303-21\s*;/.test(text) && /END-ISO-10303-21\s*;/.test(text);
  const dataAt = text.indexOf("DATA;");
  const header = dataAt > 0 ? text.slice(0, dataAt) : text.slice(0, 4000);
  const data = dataAt > 0 ? text.slice(dataAt) : text;

  const counts = {
    solids: count(data, /=\s*(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\s*\(/g),
    faces: count(data, /=\s*ADVANCED_FACE\s*\(/g),
    products: count(data, /=\s*PRODUCT\s*\(/g),
    assemblyLinks: count(data, /=\s*NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g),
  };
  const info: StepInfo = {
    schema: headerField(header, "FILE_SCHEMA"),
    description: headerField(header, "FILE_DESCRIPTION"),
    originatingSystem: (() => {
      const m = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(header);
      if (!m) return null;
      const parts = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].trim()).filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    })(),
    headerOk,
    units: detectUnits(data),
    counts,
  };

  // Entity index limited to the types needed for the product tree.
  const ents = new Map<number, { type: string; args: string[] }>();
  const re = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data))) {
    if (!NEEDED.has(m[2])) continue;
    const end = closeParen(data, re.lastIndex);
    ents.set(Number(m[1]), { type: m[2], args: splitArgs(data.slice(re.lastIndex, end)) });
    re.lastIndex = end;
  }

  const byType = (t: string) => [...ents.entries()].filter(([, e]) => e.type === t);
  const productName = (pdId: number): string => {
    const pd = ents.get(pdId);
    const pdf = pd && ents.get(refOf(pd.args[2]) ?? -1);
    const prod = pdf && ents.get(refOf(pdf.args[2]) ?? -1);
    if (prod?.type === "PRODUCT") return unquote(prod.args[1]) || unquote(prod.args[0]) || `#${pdId}`;
    return unquote(pd?.args[0]) || `#${pdId}`;
  };

  const faceCount = (shellId: number | null) => {
    const sh = shellId ? ents.get(shellId) : undefined;
    return sh?.type === "CLOSED_SHELL" ? refsIn(sh.args[1]).length : 0;
  };
  const repGeometry = new Map<number, { faces: number; solids: number }>();
  const pdsToPd = new Map<number, number>();
  for (const [id, e] of byType("PRODUCT_DEFINITION_SHAPE")) {
    const pd = refOf(e.args[2]);
    if (pd) pdsToPd.set(id, pd);
  }
  for (const [, sdr] of byType("SHAPE_DEFINITION_REPRESENTATION")) {
    const pd = pdsToPd.get(refOf(sdr.args[0]) ?? -1);
    const rep = ents.get(refOf(sdr.args[1]) ?? -1);
    if (!pd || !rep) continue;
    const acc = repGeometry.get(pd) ?? { faces: 0, solids: 0 };
    for (const item of refsIn(rep.args[1])) {
      const it = ents.get(item);
      if (it?.type === "MANIFOLD_SOLID_BREP") {
        acc.solids++;
        acc.faces += faceCount(refOf(it.args[1]));
      } else if (it?.type === "BREP_WITH_VOIDS") {
        acc.solids++;
        acc.faces += faceCount(refOf(it.args[1]));
        for (const v of refsIn(it.args[2])) acc.faces += faceCount(v);
      }
    }
    repGeometry.set(pd, acc);
  }

  const children = new Map<number, Map<number, number>>();
  const related = new Set<number>();
  for (const [, e] of byType("NEXT_ASSEMBLY_USAGE_OCCURRENCE")) {
    const parent = refOf(e.args[3]);
    const child = refOf(e.args[4]);
    if (!parent || !child) continue;
    related.add(child);
    const kids = children.get(parent) ?? new Map<number, number>();
    kids.set(child, (kids.get(child) ?? 0) + 1);
    children.set(parent, kids);
  }

  if (children.size === 0) {
    return { info, tree: null, role: "STANDALONE", levels: 0, parts: counts.solids, uniqueParts: counts.solids };
  }

  const build = (pd: number, count: number, seen: Set<number>): TreeNode => {
    const kids = children.get(pd);
    const geo = repGeometry.get(pd) ?? { faces: 0, solids: 0 };
    if (!kids || seen.has(pd)) {
      return { name: productName(pd), kind: "part", count, faces: geo.faces, solids: geo.solids, children: [] };
    }
    const next = new Set(seen).add(pd);
    const nodes = [...kids.entries()].map(([k, n]) => build(k, n, next));
    return {
      name: productName(pd),
      kind: "assembly",
      count,
      faces: nodes.reduce((s, n) => s + n.faces * n.count, 0),
      solids: nodes.reduce((s, n) => s + n.solids * n.count, 0),
      children: nodes,
    };
  };

  const roots = [...children.keys()].filter((pd) => !related.has(pd));
  const rootNodes = (roots.length ? roots : [...children.keys()].slice(0, 1)).map((r) => build(r, 1, new Set()));
  const tree: TreeNode =
    rootNodes.length === 1
      ? rootNodes[0]
      : { name: "(root)", kind: "assembly", count: 1, faces: 0, solids: 0, children: rootNodes };

  const leaves = (n: TreeNode): TreeNode[] => (n.kind === "part" ? [n] : n.children.flatMap(leaves));
  const depth = (n: TreeNode): number => (n.kind === "assembly" ? 1 + Math.max(0, ...n.children.map(depth)) : 0);
  // Instances of a node's content per single copy of that node; children multiply down the tree.
  const instances = (n: TreeNode): number =>
    n.kind === "part" ? 1 : n.children.reduce((s, c) => s + c.count * instances(c), 0);
  const leafNodes = leaves(tree);
  return {
    info,
    tree,
    role: "PARENT",
    levels: depth(tree),
    parts: instances(tree),
    uniqueParts: new Set(leafNodes.map((l) => l.name)).size,
  };
}
