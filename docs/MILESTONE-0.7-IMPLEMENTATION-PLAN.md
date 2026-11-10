# Motion Studio 0.7 — Asset intelligence and governed media intake

## Objective
Make project media traceable and reproducible before render. A production should know which exact bytes are used, where they came from, whether they changed, what kind of media they are, and whether a producer has reviewed the usage rights.

## Implemented
- [x] Workspace package `@motion-studio/asset-registry`.
- [x] Recursive, deterministic media discovery with extension/MIME classification and symlink exclusion.
- [x] Streaming SHA-256 hashing; path-specific asset IDs plus content IDs and duplicate-content grouping.
- [x] File metadata: relative path, media kind, MIME type, size, modified time, title, source, creator, description, tags, license and attribution fields.
- [x] Integrity verification for missing, modified and out-of-root files.
- [x] Human-attributed rights-review records with license, usage scope, attribution, expiry and note.
- [x] FFprobe metadata inspection using argument arrays and no shell.
- [x] Attach registry records into Canonical Video IR without mutating the original input.
- [x] IR validation for duplicate asset IDs, malformed SHA-256 and unresolved layer references (warning only, to preserve placeholder workflows).
- [x] CLI: `assets scan`, `assets verify`, `assets probe`, `assets approve-rights`, `assets attach`.
- [x] Tests for duplicate media, checksums, missing/tampered files, path traversal, rights approval and project attachment.

## CLI examples
```bash
# Scan an asset folder and write a registry
motion-studio assets scan ./media --output ./asset-registry.json

# Verify files against their recorded SHA-256 checksums
motion-studio assets verify ./asset-registry.json

# Inspect streams/format metadata for a media file (requires FFprobe)
motion-studio assets probe ./media/clip.mp4

# Record a producer's rights review for one exact asset
motion-studio assets approve-rights ./asset-registry.json \
  --asset-id asset-0123456789abcdef0123 \
  --actor "Producer" --license "Licensed stock" \
  --usage "Online advertising" --attribution "Required attribution"

# Attach registry entries into a new IR copy
motion-studio assets attach ./project.json --registry ./asset-registry.json \
  --output ./project-with-assets.json
```

## Governance
- Scanning does not imply rights clearance. New assets default to `needs-review`.
- An approval record is an auditable producer assertion, not legal advice, a license validation service or proof of ownership.
- Expired approvals are not treated as current when scanning metadata.
- Registry verification confirms byte integrity only; it does not prove the source is trustworthy or that usage rights are valid.
- Symlinks are skipped and registry-relative paths are constrained to the selected root.
- SHA-256 is streamed so large video files do not need to be loaded entirely into memory.

## Not included in this milestone
- Automatic web stock-media purchasing/downloading or license interpretation.
- Automatic proxy generation/transcoding, thumbnail extraction, waveform generation or contact sheets.
- Cloud object storage, distributed asset synchronization or collaborative locking.
- Automatic relinking across arbitrary folder moves. Use `assets verify --root <new-root>` when a project folder is relocated and paths remain the same.
- Live Adobe desktop project relinking.

## Acceptance criteria
- Duplicate byte content receives the same content ID while retaining separate path-specific asset IDs for provenance and rights.
- Missing, tampered or out-of-root paths fail verification.
- Unreviewed media is visibly marked `needs-review`.
- Rights approval requires actor, license and usage scope and remains attached to the exact asset ID.
- Project attachment is additive, deterministic and non-mutating.
- The existing project validator continues to accept placeholder assets while surfacing unresolved references as warnings.
- Cross-platform CI passes on the supported Node/OS matrix.
