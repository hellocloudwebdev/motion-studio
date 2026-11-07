# Motion Studio 0.4 — Licensed Adobe Host Acceptance

This procedure is required to close the real-host portion of 0.4. CI mocks are not accepted as evidence of After Effects or Premiere Pro execution.

## Preconditions

- A Windows or macOS workstation with a valid Adobe entitlement.
- Adobe Creative Cloud Desktop, After Effects and Premiere Pro installed and activated by the user.
- Adobe apps launched at least once and their first-run dialogs completed.
- Motion Studio 0.4 installed from the milestone branch.
- The pinned After Effects MCP and Premiere CEP bridge installed according to INSTALLATION.md.
- Node.js 24 or newer.
- A disposable local test workspace. Do not use a production project or overwrite an existing user timeline.

Record OS build, Node version, AE version, Premiere version, Media Encoder version, AE MCP package version, Premiere bridge version and Motion Studio commit.

## A. After Effects

1. Launch After Effects and open a disposable, saved test project.
2. Start the After Effects MCP bridge and run Motion Studio's Adobe preflight/read-only inspection.
3. Confirm the live operation catalog is read and the scoped allowlist is applied. Confirm arbitrary ExtendScript evaluation remains disabled.
4. Build a minimal Canonical IR test scene containing one text layer and one rectangle/solid layer.
5. Run AE scene preview. Save the returned approval ID and the project revision/hash.
6. Review the planned composition, layer types, paths and backup location.
7. Approve the exact preview once; apply the scene.
8. Confirm the project backup exists, the composition and layers are visible in AE, the project was saved, and a fresh readback reports the expected composition/layer IDs.
9. Capture the PNG frame proof and the sanitized Motion Studio run receipt.
10. Close and reopen the saved test project; repeat read-only readback to confirm persistence.

**Pass evidence:** sanitized preflight receipt, preview/approval record, backup path/checksum, post-apply readback, PNG proof, saved project version and reopen verification.

## B. Premiere Pro and Media Encoder

1. Launch Premiere Pro and open a disposable, saved test project.
2. Start the CEP bridge and run read-only preflight. Confirm the expected bridge/backend is reported ready.
3. Render or use the verified 0.4 HyperFrames smoke MP4 as the source clip.
4. Run Premiere assembly preview. Confirm the source file identity/checksum, project path and distinct backup path.
5. Approve the exact preview once; apply the import and new-sequence workflow.
6. Confirm the backup exists, source item identity is correct, a new sequence was created, and paginated readback contains the expected imported clip IDs.
7. Save the project, close and reopen it, and repeat readback.
8. Select an explicit user-owned Media Encoder .epr preset and run the optional export workflow.
9. Verify the output exists, its checksum/size matches the receipt, and FFprobe reports the expected video stream, dimensions, frame rate and duration.

**Pass evidence:** preflight receipt, preview/approval record, project backup/checksum, source identity, sequence readback, save/reopen verification, export receipt, output checksum and FFprobe report.

## Safety and failure handling

- Use only disposable projects and test media.
- Never bypass Adobe licensing, trust prompts or user approvals.
- Do not manually edit opaque .aep or .prproj binary files.
- If an operation times out or its result is uncertain, inspect host state and reconcile before any retry.
- Do not rerun an approval token. Generate a fresh preview and approval for every mutation.
- Redact usernames, absolute home paths, license/account identifiers and any secrets before attaching receipts.
- A mocked test, CLI success message or screenshot without host readback is insufficient.

## Acceptance record

Attach sanitized receipts and a short pass/fail note for each step to PR #2. Include the exact Motion Studio commit tested. Any failure must include the failing operation, host version, sanitized logs and whether the project remained unchanged or was restored from backup.
