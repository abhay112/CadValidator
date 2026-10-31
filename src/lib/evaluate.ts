import { MAX_ASPECT, MAX_FACES, MAX_SOLIDS, MIN_FACES, MIN_FEATURE_FRACTION } from "./limits";
import type { Failure, Measures } from "./types";

/** Apply the spec rules to a set of measurements (validate.py `evaluate`). */
export function evaluate(m: Measures): Failure[] {
  const fails: Failure[] = [];
  if (m.solids < 1) fails.push({ code: "no_solid", message: "no solid geometry" });
  if (m.solids > MAX_SOLIDS) {
    fails.push({ code: "too_many_solids", message: `${m.solids} solids > ${MAX_SOLIDS}` });
  }
  if (m.faces < MIN_FACES || m.faces > MAX_FACES) {
    fails.push({ code: "face_range", message: `${m.faces} faces outside ${MIN_FACES}-${MAX_FACES}` });
  }
  const nonAnalytic = m.faceTypes["non_analytic"];
  if (nonAnalytic) {
    fails.push({ code: "non_analytic", message: `${nonAnalytic} non-analytic (B-spline etc.) faces` });
  }
  if (m.aspectRatio === null || m.aspectRatio > MAX_ASPECT) {
    fails.push({ code: "aspect", message: `aspect ratio ${m.aspectRatio} > ${MAX_ASPECT}` });
  }
  const sf = m.smallestFeature;
  if (sf && sf.size < MIN_FEATURE_FRACTION * m.longest) {
    fails.push({
      code: "small_feature",
      message:
        `smallest feature ${sf.kind}=${sf.size.toFixed(3)} < ` +
        `${Math.round(MIN_FEATURE_FRACTION * 100)}% of longest dim ${m.longest.toFixed(3)}`,
    });
  }
  if (m.solids > 0 && m.shells > m.solids) {
    fails.push({ code: "cavity", message: `${m.shells - m.solids} internal void shell(s): hidden cavities are rejected` });
  }
  if (!m.validBrep) fails.push({ code: "invalid_brep", message: "BRepCheck reports invalid shape" });
  if (m.freeEdges !== 0) {
    fails.push({ code: "free_edges", message: `free edges (gaps/open shell): ${m.freeEdges}` });
  }
  if (m.volume <= 0) fails.push({ code: "volume", message: "non-positive volume" });
  return fails;
}

/** Compare original and re-exported measurements (the tail of validate.py `validate`). */
export function compareReexport(m1: Measures, m2: Measures): Failure[] {
  const fails: Failure[] = evaluate(m2).map((f) => ({
    code: `after_reexport:${f.code}`,
    message: `after re-export: ${f.message}`,
  }));
  if (m1.solids !== m2.solids) {
    fails.push({ code: "reexport_changed_solids", message: `re-export changed solids: ${m1.solids} -> ${m2.solids}` });
  }
  if (m1.faces !== m2.faces) {
    fails.push({ code: "reexport_changed_faces", message: `re-export changed faces: ${m1.faces} -> ${m2.faces}` });
  }
  if (Math.abs(m1.volume - m2.volume) > 1e-4 * Math.max(Math.abs(m1.volume), 1)) {
    fails.push({ code: "reexport_changed_volume", message: "re-export changed volume" });
  }
  return fails;
}

const AFTER = "after_reexport:";

/**
 * validate.py lists a problem twice when it survives the STEP round-trip ("X" and "after re-export: X").
 * Keep the echo only when the round-trip introduced the problem.
 */
export function dropReexportEchoes(fails: Failure[]): Failure[] {
  return fails.filter((f) => !f.code.startsWith(AFTER) || !fails.some((g) => g.code === f.code.slice(AFTER.length)));
}

/** True when a failure is a per-child rule (or the re-export echo of one). */
export function isPerChildFailure(f: Failure, perChild: Set<string>): boolean {
  const base = f.code.startsWith(AFTER) ? f.code.slice(AFTER.length) : f.code;
  return perChild.has(base);
}
