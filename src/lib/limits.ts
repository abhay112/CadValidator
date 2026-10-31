// Spec limits, mirrored from validator/validate.py (Kuinbee spec section 5).
export const MIN_FACES = 10;
export const MAX_FACES = 300;
export const MAX_SOLIDS = 5;
export const MAX_ASPECT = 10.0;
export const MIN_FEATURE_FRACTION = 0.02;

// Uniqueness thresholds, mirrored from validator/uniqueness.py (spec section 6).
export const NEAR_TOL = 0.08;
export const EXACT_TOL = 1e-4;

export interface RuleDef {
  code: string;
  title: string;
  requirement: string;
}

/** Display order of the checks table. `code` matches Failure.code. */
export const RULES: RuleDef[] = [
  { code: "no_solid", title: "Solid geometry", requirement: "at least 1 solid" },
  { code: "too_many_solids", title: "Solid count", requirement: `at most ${MAX_SOLIDS} solids` },
  { code: "face_range", title: "Face count", requirement: `${MIN_FACES}–${MAX_FACES} faces` },
  { code: "non_analytic", title: "Analytic surfaces", requirement: "plane, cylinder, cone, sphere, torus only" },
  { code: "aspect", title: "Proportions", requirement: `longest / shortest bbox side ≤ ${MAX_ASPECT}` },
  { code: "small_feature", title: "Feature size", requirement: `smallest radius ≥ ${MIN_FEATURE_FRACTION * 100}% of longest side` },
  { code: "invalid_brep", title: "B-rep validity", requirement: "BRepCheck_Analyzer reports valid" },
  { code: "free_edges", title: "Closed shell", requirement: "no free edges (gaps / open shell)" },
  { code: "volume", title: "Volume", requirement: "positive volume" },
  { code: "reexport", title: "STEP re-export", requirement: "re-exports, reopens, same solids / faces / volume" },
];

export const REEXPORT_CODES = [
  "reexport_failed",
  "reexport_reopen",
  "reexport_changed_solids",
  "reexport_changed_faces",
  "reexport_changed_volume",
];

/** Rules that apply to each child part of an assembly rather than to the parent file itself. */
export const PER_CHILD_CODES = new Set([
  "too_many_solids",
  "face_range",
  "non_analytic",
  "aspect",
  "small_feature",
  // validate_server.py drops any message containing "solids", which includes this one.
  "reexport_changed_solids",
]);
