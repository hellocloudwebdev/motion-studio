import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../../core/src/index.mjs';
import { inspectMedia, probeMedia } from '../../ffmpeg/src/index.mjs';
import { resolveHyperFramesCli } from '../../render-manager/src/index.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRIMITIVES = new Set(['box', 'sphere', 'icosahedron', 'cylinder', 'cone', 'torus', 'plane']);
const HEX = /^#[\da-f]{6}$/i;

function inside(root, target, label) {
  const resolvedRoot = path.resolve(root), resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(label + ' must be a child path inside the project workspace.');
  return resolvedTarget;
}

function vector(value, fallback, field) {
  const input = value ?? fallback;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(field + ' must be a numeric x/y/z vector.');
  const result = {};
  for (const axis of ['x', 'y', 'z']) {
    const number = Number(input[axis] ?? 0);
    if (!Number.isFinite(number) || Math.abs(number) > 100000) throw new Error(field + '.' + axis + ' must be finite and within the supported range.');
    result[axis] = number;
  }
  return result;
}

function sceneSpec(project, scene) {
  if (!scene || !Array.isArray(scene.layers) || scene.layers.length === 0) throw new Error('Three.js scene must contain at least one authored layer.');
  const durationFrames = scene.durationFrames;
  if (!Number.isInteger(durationFrames) || durationFrames < 1) throw new Error('Three.js scene duration must be a positive integer frame count.');
  const objects = [];
  let camera = scene.camera || {};
  for (const layer of scene.layers) {
    if (layer.kind === 'camera') {
      camera = layer.content || layer.camera || camera;
      continue;
    }
    if (layer.kind !== '3d') throw new Error('Three.js adapter does not support layer kind ' + layer.kind + '; route mixed 2D content through its own engine and editorial assembly.');
    if (layer.assetId) throw new Error('Three.js model asset import is not implemented yet; refusing to replace it with placeholder geometry.');
    const content = layer.content && typeof layer.content === 'object' && !Array.isArray(layer.content) ? layer.content : {};
    const primitive = content.primitive;
    if (!PRIMITIVES.has(primitive)) throw new Error('Layer ' + layer.id + ' needs a supported explicit Three.js primitive.');
    const color = content.material?.color || layer.style?.color || project.brand?.colors?.accent || '#ffffff';
    if (!HEX.test(color)) throw new Error('Layer ' + layer.id + ' has an invalid material color.');
    const keyframes = content.keyframes || [];
    if (!Array.isArray(keyframes)) throw new Error('Layer ' + layer.id + ' keyframes must be an array.');
    let previousFrame = -1;
    const frames = keyframes.map((keyframe, index) => {
      if (!Number.isInteger(keyframe.frame) || keyframe.frame < 0 || keyframe.frame >= durationFrames || keyframe.frame <= previousFrame) throw new Error('Layer ' + layer.id + ' keyframe ' + index + ' must use a unique, ascending frame inside the scene.');
      previousFrame = keyframe.frame;
      return {
        frame: keyframe.frame,
        position: keyframe.position === undefined ? null : vector(keyframe.position, {}, 'keyframe.position'),
        rotation: keyframe.rotation === undefined ? null : vector(keyframe.rotation, {}, 'keyframe.rotation'),
        scale: keyframe.scale === undefined ? null : vector(keyframe.scale, {}, 'keyframe.scale')
      };
    });
    objects.push({
      id: layer.id,
      primitive,
      color,
      position: vector(content.position ?? layer.transform, { x: 0, y: 0, z: 0 }, 'layer.position'),
      rotation: vector(content.rotation, { x: 0, y: 0, z: 0 }, 'layer.rotation'),
      scale: vector(content.scale, { x: 1, y: 1, z: 1 }, 'layer.scale'),
      frames
    });
  }
  if (!objects.length) throw new Error('Three.js scene has no supported 3D objects.');
  const position = vector(camera.position, { x: 0, y: 0, z: 6 }, 'camera.position');
  const lookAt = vector(camera.lookAt, { x: 0, y: 0, z: 0 }, 'camera.lookAt');
  const fov = Number(camera.fov ?? 45);
  if (!Number.isFinite(fov) || fov < 10 || fov > 120) throw new Error('Camera fov must be between 10 and 120 degrees.');
  return {
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    sceneId: scene.id,
    sceneName: scene.name || scene.id,
    width: project.project.canvas.width,
    height: project.project.canvas.height,
    frameRate: project.project.frameRate,
    durationFrames,
    background: project.brand?.colors?.background || '#101010',
    camera: { position, lookAt, fov },
    objects
  };
}

function htmlFor(spec) {
  const safeId = String(spec.sceneId).replace(/[^a-zA-Z0-9_-]/g, '-');
  const compositionId = 'threejs-' + safeId;
  const encodedSpec = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const duration = spec.durationFrames * spec.frameRate.denominator / spec.frameRate.numerator;
  if (!HEX.test(spec.background)) throw new Error('Three.js scene background must be a #RRGGBB color.');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${spec.sceneName.replace(/[&<>"']/g, '')}</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${spec.background}} [data-composition-id]{position:relative;overflow:hidden;width:${spec.width}px;height:${spec.height}px;transform-origin:50% 50%;background:${spec.background}} canvas{display:block;width:100%;height:100%}</style>
<script src="./assets/gsap.min.js"></script></head><body>
<div id="${compositionId}" data-composition-id="${compositionId}" data-start="0" data-duration="${duration}" data-width="${spec.width}" data-height="${spec.height}"><canvas id="render"></canvas></div>
<script type="module">
import * as THREE from './assets/three.module.js';
const spec=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encodedSpec}'),c=>c.charCodeAt(0))));
const compositionId=${JSON.stringify(compositionId)};
const canvas=document.getElementById('render');
const renderer=new THREE.WebGLRenderer({canvas,antialias:false,alpha:false,powerPreference:'low-power'});
renderer.setPixelRatio(1);renderer.setSize(spec.width,spec.height,false);renderer.setClearColor(spec.background,1);
const scene=new THREE.Scene();scene.background=new THREE.Color(spec.background);
const camera=new THREE.PerspectiveCamera(spec.camera.fov,spec.width/spec.height,0.1,10000);
camera.position.set(spec.camera.position.x,spec.camera.position.y,spec.camera.position.z);camera.lookAt(spec.camera.lookAt.x,spec.camera.lookAt.y,spec.camera.lookAt.z);
scene.add(new THREE.AmbientLight(0xffffff,1.6));
const keyLight=new THREE.DirectionalLight(0xffffff,2.2);keyLight.position.set(-3,5,7);scene.add(keyLight);
function geometry(primitive){switch(primitive){case'box':return new THREE.BoxGeometry(1,1,1);case'sphere':return new THREE.SphereGeometry(.5,32,24);case'icosahedron':return new THREE.IcosahedronGeometry(.62,1);case'cylinder':return new THREE.CylinderGeometry(.5,.5,1,32);case'cone':return new THREE.ConeGeometry(.55,1,32);case'torus':return new THREE.TorusGeometry(.48,.18,16,48);case'plane':return new THREE.PlaneGeometry(1,1);default:throw new Error('Unsupported primitive');}}
const instances=spec.objects.map(item=>{const object=new THREE.Mesh(geometry(item.primitive),new THREE.MeshStandardMaterial({color:item.color,metalness:.15,roughness:.55}));object.name=item.id;scene.add(object);return{spec:item,object};});
function mix(a,b,t){return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};}
function transformAt(item,frame){const keys=item.frames;if(!keys.length)return{position:item.position,rotation:item.rotation,scale:item.scale};let left={frame:0,position:item.position,rotation:item.rotation,scale:item.scale},right=null;for(const key of keys){right={frame:key.frame,position:key.position||left.position,rotation:key.rotation||left.rotation,scale:key.scale||left.scale};if(frame<=right.frame)break;left=right;right=null;}if(!right)return{position:left.position,rotation:left.rotation,scale:left.scale};const t=right.frame===left.frame?0:Math.max(0,Math.min(1,(frame-left.frame)/(right.frame-left.frame)));return{position:mix(left.position,right.position,t),rotation:mix(left.rotation,right.rotation,t),scale:mix(left.scale,right.scale,t)};}
function renderAtFrame(frame){for(const {spec:item,object} of instances){const t=transformAt(item,frame);object.position.set(t.position.x,t.position.y,t.position.z);object.rotation.set(t.rotation.x,t.rotation.y,t.rotation.z);object.scale.set(t.scale.x,t.scale.y,t.scale.z);}renderer.render(scene,camera);}
const playhead={frame:0};const timeline=gsap.timeline({paused:true});timeline.fromTo(document.getElementById(compositionId),{scale:.99},{scale:1,duration:${duration},ease:'none'},0);timeline.to(playhead,{frame:spec.durationFrames,duration:${duration},ease:'none',onUpdate:()=>renderAtFrame(playhead.frame)},0);window.__timelines=window.__timelines||{};window.__timelines[compositionId]=timeline;window.renderAtFrame=renderAtFrame;renderAtFrame(0);window.__threeReady=true;
</script></body></html>`;
}

function execute(executable, args, { cwd, env = process.env, timeoutMs = 600_000, signal } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Three.js renderer requires a validated argument array.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-20000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const result = { code, stdout, stderr };
      if (code === 0) resolve(result);
      else reject(new Error('Three.js render process failed (' + code + '). stderr: ' + stderr.slice(-2000) + ' stdout: ' + stdout.slice(-2000)));
    });
  });
}

export function validateThreeJsScene(project, sceneId) {
  const validation = validateProject(project);
  if (!validation.valid) return { valid: false, issues: validation.issues };
  const scene = project.scenes.find(item => item.id === sceneId);
  if (!scene) return { valid: false, issues: [{ code: 'SCENE_NOT_FOUND', sceneId }] };
  try { return { valid: true, scene: sceneSpec(project, scene), issues: [] }; }
  catch (error) { return { valid: false, issues: [{ code: 'THREEJS_SCENE_UNSUPPORTED', message: error.message }] }; }
}

export async function compileThreeJsScene(project, sceneId, options = {}) {
  const validation = validateThreeJsScene(project, sceneId);
  if (!validation.valid) throw new Error('Cannot render Three.js scene: ' + JSON.stringify(validation.issues));
  const spec = validation.scene;
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = inside(projectRoot, path.resolve(options.outputDir || path.join(projectRoot, 'engines', 'threejs', spec.sceneId)), 'Three.js engine directory');
  await mkdir(path.join(outputDir, 'assets'), { recursive: true });
  const threeSource = path.resolve(options.installRoot || MODULE_ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  const threeCoreSource = path.resolve(options.installRoot || MODULE_ROOT, 'node_modules', 'three', 'build', 'three.core.js');
  const gsapSource = path.resolve(options.installRoot || MODULE_ROOT, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
  await Promise.all([access(threeSource), access(threeCoreSource), access(gsapSource)]);
  await Promise.all([
    copyFile(threeSource, path.join(outputDir, 'assets', 'three.module.js')),
    copyFile(threeCoreSource, path.join(outputDir, 'assets', 'three.core.js')),
    copyFile(gsapSource, path.join(outputDir, 'assets', 'gsap.min.js')),
    writeFile(path.join(outputDir, 'index.html'), htmlFor(spec), 'utf8')
  ]);
  return { outputDir, htmlPath: path.join(outputDir, 'index.html'), spec };
}

export async function renderThreeJsScene(project, sceneId, options = {}) {
  const validation = validateThreeJsScene(project, sceneId);
  if (!validation.valid) throw new Error('Cannot render Three.js scene: ' + JSON.stringify(validation.issues));
  const spec = validation.scene;
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputRoot = inside(projectRoot, path.resolve(options.outputRoot || path.join(projectRoot, 'renders')), 'Three.js output directory');
  const quality = options.quality || 'draft';
  if (!['draft', 'standard', 'high'].includes(quality)) throw new Error('Unsupported Three.js render quality: ' + quality);
  await mkdir(outputRoot, { recursive: true });
  const compiled = await compileThreeJsScene(project, sceneId, { ...options, projectRoot });
  const outputDir = compiled.outputDir;
  const sourceSha256 = createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const cli = await resolveHyperFramesCli(options.installRoot || MODULE_ROOT);
  const checks = [];
  const run = async (name, args) => {
    const result = await execute(process.execPath, [cli.entry, ...args], { cwd: outputDir, timeoutMs: options.timeoutMs || 600_000, signal: options.signal, env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' } });
    checks.push({ name, exitCode: result.code });
    if (name === 'lint' || name === 'check') {
      let report;
      try { report = JSON.parse(result.stdout); } catch { throw new Error('HyperFrames ' + name + ' did not return valid JSON.'); }
      if (report.ok !== true) throw new Error('HyperFrames ' + name + ' reported defects: ' + JSON.stringify(report));
    }
    return result;
  };
  await run('lint', ['lint', outputDir, '--json']);
  await run('check', ['check', outputDir, '--json']);
  const snapshotDir = path.join(outputDir, 'snapshots');
  await run('snapshot', ['snapshot', outputDir, '--at', '0', '--output', snapshotDir, '--describe', 'false']);
  const snapshots = (await readdir(snapshotDir)).filter(name => /^frame-.*\.png$/i.test(name));
  if (!snapshots.length) throw new Error('HyperFrames snapshot verification did not produce any frame evidence.');
  for (const name of snapshots) {
    const buffer = await readFile(path.join(snapshotDir, name));
    if (buffer.length < 16 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG snapshot evidence: ' + name);
  }
  const fps = spec.frameRate.numerator / spec.frameRate.denominator;
  const output = path.join(outputRoot, spec.projectId + '-' + spec.sceneId + '-threejs-' + quality + '.mp4');
  await run('render', ['render', '--output', output, '--fps', String(fps), '--quality', quality, '--workers', '1', '--low-memory-mode']);
  const media = await probeMedia(output, { signal: options.signal });
  const verification = inspectMedia(media, { width: spec.width, height: spec.height, fps, durationSeconds: spec.durationFrames / fps, durationToleranceSeconds: 1 / fps });
  if (!verification.passed) throw new Error('Three.js output failed independent FFprobe verification: ' + JSON.stringify(verification.failures));
  const fileInfo = await stat(output);
  if (!fileInfo.isFile() || fileInfo.size === 0) throw new Error('Three.js output artifact is empty or missing.');
  const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
  const receipt = {
    schemaVersion: '1.0.0', engine: 'threejs', projectId: spec.projectId, projectRevision: spec.projectRevision,
    sceneId: spec.sceneId, sceneName: spec.sceneName, sourceSha256,
    artifact: { path: output, sha256: outputSha256, byteSize: fileInfo.size, container: 'mp4', codec: media.videoCodec,
      width: media.width, height: media.height, frameRate: spec.frameRate, durationFrames: spec.durationFrames,
      durationSeconds: media.durationSeconds, colorSpace: 'sRGB', alpha: false, audio: { present: media.hasAudio, codec: media.audioCodec || null } },
    verification, checks, snapshots: snapshots.map(name => path.join(snapshotDir, name)), verified: true, completedAt: new Date().toISOString(), hyperframesVersion: cli.version
  };
  await writeFile(output + '.threejs.json', JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return receipt;
}
