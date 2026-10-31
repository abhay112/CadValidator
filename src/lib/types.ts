export type Format = "step" | "fcstd";

export interface Failure {
  code: string;
  message: string;
}

export interface Measures {
  solids: number;
  shells: number;
  faces: number;
  faceTypes: Record<string, number>;
  bboxDimsSorted: number[];
  longest: number;
  aspectRatio: number | null;
  volume: number;
  area: number;
  validBrep: boolean;
  freeEdges: number;
  smallestFeature: { kind: string; size: number } | null;
  /** Principal moments of inertia, ascending. */
  moments: number[];
}

/** Invariant to rotation, translation, mirroring and uniform scale. */
export interface Signature {
  faceTypes: Record<string, number>;
  faces: number;
  longest: number;
  vec: number[];
  hash: string;
}

export interface ChildReport {
  name: string;
  count: number;
  measures: Measures;
  failures: Failure[];
  passed: boolean;
  signature: Signature | null;
}

export interface TreeNode {
  name: string;
  kind: "assembly" | "part";
  count: number;
  faces: number;
  solids: number;
  children: TreeNode[];
}

export interface StepInfo {
  schema: string | null;
  description: string | null;
  originatingSystem: string | null;
  headerOk: boolean;
  counts: { solids: number; faces: number; products: number; assemblyLinks: number };
}

export interface FcstdInfo {
  objects: number;
  bodies: number;
  parts: number;
  sketches: number;
  pads: number;
  pockets: number;
  dressUps: number;
  brepFiles: number;
  /** A = parametric PartDesign history present, B = geometry only. */
  designClass: "A" | "B";
  programVersion: string | null;
  usedShapes: string[];
}

export interface Report {
  file: string;
  size: number;
  format: Format;
  sha256: string;
  parsed: boolean;
  passed: boolean;
  failures: Failure[];
  role: "STANDALONE" | "PARENT";
  measures: Measures | null;
  reexport: Measures | null;
  reexportOk: boolean | null;
  children: ChildReport[];
  tree: TreeNode | null;
  levels: number;
  parts: number;
  uniqueParts: number;
  step: StepInfo | null;
  fcstd: FcstdInfo | null;
  /** One signature per standalone file, or one per unique child of an assembly. */
  signatures: { label: string; signature: Signature }[];
  notes: string[];
  elapsedMs: number;
}

export type ToWorker =
  | { type: "init" }
  | { type: "validate"; id: number; name: string; buffer: ArrayBuffer }
  | { type: "sample"; id: number; kind: SampleKind };

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "initError"; message: string }
  | { type: "result"; id: number; report: Report }
  | { type: "sample"; id: number; name: string; buffer: ArrayBuffer }
  | { type: "error"; id: number; message: string };

export type SampleKind = "flange" | "strip" | "cube" | "fcstd";
