# Asset library and media intake

Motion Studio's asset registry records exact media files used by a production. It is a local manifest; it does not upload media to a server or automatically clear copyright.

## Supported media families

The scanner recognizes common video, audio, image, font, document and 3D formats. Unsupported files are skipped. Hidden files are skipped by default; symlinks are always skipped.

## Typical workflow

1. Keep source media in a dedicated folder such as `media/`.
2. Run `motion-studio assets scan ./media --output ./asset-registry.json`.
3. Review the duplicate groups and the `needsRightsReview` count.
4. Use `motion-studio assets probe ./media/clip.mp4` to inspect media streams with FFprobe.
5. Record explicit producer rights review with `assets approve-rights`.
6. Attach the reviewed registry to a new Canonical Video IR copy using `assets attach`.
7. Run `assets verify` before render or after transferring the project folder.

## Registry identity and integrity

Each file receives a SHA-256 digest, a stable path-specific `asset-...` ID, and a shared content ID derived from its digest. Identical files at different paths remain separate provenance/rights records but share a content ID and are listed in a duplicate group. The registry also stores a root directory and root-relative paths. When moving the folder, verify with `--root <new-root>` if the relative layout is unchanged.

Integrity verification catches changed or missing files. It does not detect whether a license is valid or whether an asset is appropriate for a particular campaign.

## Rights review

All scanned assets start as `needs-review` unless a still-current approval record was supplied in scan metadata. The CLI approval command records:
- Producer/reviewer actor
- License label or agreement reference
- Intended usage scope
- Optional attribution, expiry and note
- Approval timestamp

This is a record of human review, not legal clearance. Keep the actual license agreement and source receipt with the project. Do not mark assets approved unless the producer has checked the applicable terms.

## Safety and performance

- SHA-256 uses streaming file reads, suitable for large video assets.
- Symbolic links are skipped and paths are checked against the selected root.
- FFprobe is invoked with a fixed executable plus argument array; shell interpolation is not used.
- Asset scan does not modify or move source media.
- Registry attachment creates a new IR object and the CLI writes a separate output file by default.
