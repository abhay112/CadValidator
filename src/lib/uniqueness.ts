import { EXACT_TOL, NEAR_TOL } from "./limits";
import type { Measures, Signature } from "./types";

// cyrb53: small, fast, good-enough fingerprint for a display label.
function fingerprint(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** uniqueness.py `signature`: normalised volume, area, bbox proportions, principal moments, face-type histogram. */
export function signatureOf(m: Measures): Signature | null {
  const L = m.longest;
  const V = m.volume;
  if (!(L > 0) || !(V > 0)) return null;
  const d = m.bboxDimsSorted;
  const vec = [V / L ** 3, m.area / L ** 2, d[0] / L, d[1] / L, ...m.moments.map((i) => i / (V * L ** 2))];
  const sortedTypes = Object.entries(m.faceTypes).sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    faceTypes: m.faceTypes,
    faces: m.faces,
    longest: L,
    vec,
    hash: fingerprint(JSON.stringify([sortedTypes, vec.map((x) => Math.round(x * 1000) / 1000)])),
  };
}

function rel(a: number[], b: number[]): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const denom = Math.max(Math.abs(a[i]), Math.abs(b[i]), 1e-12);
    worst = Math.max(worst, Math.abs(a[i] - b[i]) / denom);
  }
  return worst;
}

function sameHistogram(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export type Similarity = "exact" | "scaled" | "near" | "distinct";

/** uniqueness.py `compare`. */
export function compare(sa: Signature, sb: Signature): { distance: number; kind: Similarity } {
  if (!sameHistogram(sa.faceTypes, sb.faceTypes)) return { distance: 1, kind: "distinct" };
  const distance = rel(sa.vec, sb.vec);
  if (distance > NEAR_TOL) return { distance, kind: "distinct" };
  if (distance < EXACT_TOL) {
    const sameSize = Math.abs(sa.longest - sb.longest) <= 1e-3 * Math.max(sa.longest, sb.longest);
    return { distance, kind: sameSize ? "exact" : "scaled" };
  }
  return { distance, kind: "near" };
}

export interface Registered {
  file: string;
  label: string;
  signature: Signature;
}

export interface Match {
  label: string;
  of: string;
  kind: Exclude<Similarity, "distinct">;
  distance: number;
}

/** Session-only registry: compares against files checked earlier in this tab, nothing is stored. */
export class UniquenessRegistry {
  private entries: Registered[] = [];

  check(file: string, sigs: { label: string; signature: Signature }[]): Match[] {
    const matches: Match[] = [];
    for (const s of sigs) {
      let best: Match | null = null;
      for (const e of this.entries) {
        if (e.file === file) continue;
        const { distance, kind } = compare(s.signature, e.signature);
        if (kind === "distinct") continue;
        if (!best || distance < best.distance) {
          best = { label: s.label, of: e.label === e.file ? e.file : `${e.file} › ${e.label}`, kind, distance };
        }
      }
      if (best) matches.push(best);
    }
    return matches;
  }

  add(file: string, sigs: { label: string; signature: Signature }[]): void {
    this.entries = this.entries.filter((e) => e.file !== file);
    for (const s of sigs) this.entries.push({ file, label: s.label, signature: s.signature });
  }

  remove(file: string): void {
    this.entries = this.entries.filter((e) => e.file !== file);
  }

  clear(): void {
    this.entries = [];
  }
}
