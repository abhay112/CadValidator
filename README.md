# CAD Validator

Validate **STEP** (`.step`, `.stp`) and **FreeCAD** (`.FCStd`) files entirely in the browser.
No backend, no upload, nothing stored: files are read in memory, checked by a WebAssembly build of
OpenCASCADE running in a Web Worker, and discarded when you close the tab.

It is a client-side port of the validation logic in
[`abhay112/step-cad-validator`](https://github.com/abhay112/step-cad-validator)
(`validator/validate.py`, `uniqueness.py`, `structure.py`, plus the quick checks in the Vercel viewer).

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (deploy anywhere: Vercel, Netlify, GitHub Pages, S3)
```

The first visit downloads the geometry engine (~66 MB, ~14 MB compressed). Browsers cache it afterwards.

## What is checked

Limits come straight from `validator/validate.py` (Kuinbee spec section 5), see [`src/lib/limits.ts`](src/lib/limits.ts).

| Rule | Requirement |
| --- | --- |
| Solid geometry / count | at least 1, at most 5 solids |
| Face count | 10 to 300 faces |
| Analytic surfaces | plane, cylinder, cone, sphere, torus only (B-spline etc. fail) |
| Proportions | longest / shortest bounding-box side at most 10 |
| Feature size | smallest cylinder, sphere or torus radius at least 2% of the longest side |
| B-rep validity | `BRepCheck_Analyzer` reports valid |
| Closed shell | no free edges (`ShapeAnalysis_FreeBounds`), i.e. no gaps |
| Volume | positive |
| STEP re-export | re-export, reopen, re-measure: same solids, faces, volume (1e-4), rules still hold |

**Assemblies.** When a STEP file has `NEXT_ASSEMBLY_USAGE_OCCURRENCE` links (or an `.FCStd` has several
bodies), the face / solid / proportion / feature / analytic rules apply to **each part**, while the parent
file itself must be a valid, closed, re-exportable B-rep. This mirrors `generators/validate_server.py`.

**Uniqueness (spec section 6).** The rotation, translation, mirror and scale invariant signature is ported
unchanged (`TOL` 0.08). Without the catalogue there is nothing to compare against, so files are compared
only with the other files checked in the same tab. It is informational and does not change PASS / FAIL.

## `.FCStd`

An `.FCStd` is a zip. The app reads `Document.xml` for the object tree and design history
(class A = PartDesign Body with Sketch / Pad / Pocket, class B = geometry only) and loads the cached
`*.brp` shapes of each Body (or of each finished Part feature when there is no Body) for geometry checks.
The design class is shown but does not fail a file. Models saved without their cached shapes cannot be checked.

## Layout

```
src/lib/        pure logic: limits, rule evaluation, uniqueness, STEP text + FreeCAD document parsing
src/worker/     OpenCASCADE engine (measure, validate, re-export round trip) and the worker entry
src/ui/         drop zone, report cards, styles
```

## Known limits

- Files up to 150 MB; very large models are slow because the kernel is single-threaded WASM.
- Assembly parts are the solids found in the file, labelled `Solid 1..n`. Product names come from the
  STEP text and appear in the structure tree, not in the per-part table.
- `opencascade.js@1.1.1` corrupts its heap when a file path passed to the kernel exceeds about ten
  characters, so the worker only uses short recycled names (`/a.step`). Keep that if you edit the engine.
- Sample files (the links under the drop zone) are generated in the browser to try the app and are not part of the spec.
