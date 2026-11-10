# Editorial assembly planning

Generate a frame-accurate sequence manifest from a Canonical Video IR project:

```bash
motion-studio editorial plan project.json --output assembly.json
motion-studio editorial validate assembly.json
```

Scenes are laid sequentially in project order. Layer `startFrame` and `durationFrames` are relative to their containing scene; omitted start defaults to zero and omitted duration extends to the scene end. Video, audio and graphics clips receive deterministic tracks. Overlapping clips are assigned additional lanes rather than silently colliding.

The manifest preserves rational frame rate, integer frame positions, scene and clip identifiers, source asset URI/checksum, and rights-review status. Unresolved assets, missing media references, and assets awaiting rights review are explicit warnings. Structural errors such as invalid layer ranges or total scene duration exceeding the project duration make the plan invalid.

This is a planning and interchange artifact. It does not create or modify Premiere projects, write to Adobe applications, or constitute legal rights clearance. Source project files and media remain unchanged.
