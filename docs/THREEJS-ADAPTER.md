# Three.js scene adapter

Motion Studio's Three.js adapter compiles a scene from Canonical Video IR to a self-contained local HyperFrames composition, then renders it through the HyperFrames browser workflow. The IR remains canonical; the generated HTML, copied libraries, frame captures, MP4 and `.threejs.json` receipt are engine outputs.

## Use

```powershell
node apps/cli/src/index.mjs render-threejs templates/threejs-demo/project.json scene-001 --quality draft --project-root projects/threejs-demo
```

The project root must be a child of the current workspace. The command runs lint, runtime/layout checking, frame snapshot capture, and a single-worker render. The returned receipt is marked verified only after FFprobe confirms dimensions, rational frame rate, duration, codec and a nonempty output file; hashes identify both the input IR and MP4.

The same operation is available to MCP hosts as `video.render_threejs_scene` after a project has been stored in the workspace using `video.render_project`.

## Supported IR subset

- Scene camera position, look-at target and perspective field of view.
- Ambient and directional default lighting.
- Explicit box, sphere, icosahedron, cylinder, cone, torus and plane geometry.
- Explicit hex material colors, transforms and integer frame keyframes for position, rotation and scale.
- Linear keyframe interpolation and deterministic seeking by project frame.
- Local copies of the installed Three.js and GSAP runtime; no remote scripts.

The adapter rejects non-3D scene layers, unresolved model assets, unsupported primitives and malformed keyframes. Route mixed 2D/3D scenes through separate renderers and editorial assembly. Model import, custom shaders, particles, alpha output, advanced material/light authoring and image-sequence delivery are not implemented by this adapter yet. Output is opaque sRGB H.264 MP4.

## Runtime evidence

`templates/threejs-demo/project.json` is a small runtime fixture. Its verified draft render is written under the ignored project workspace `projects/threejs-demo/renders/`; it is local evidence, not a checked-in golden artifact. The adapter records the engine version, checks, sample frame paths, output metadata and hashes in the sidecar receipt.
