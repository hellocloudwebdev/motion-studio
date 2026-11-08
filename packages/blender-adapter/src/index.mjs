import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OBJECTS = new Set(['cube', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus']);
const PYTHON_DRIVER = String.raw`import bpy, json, math, os, re, sys

def args_after_separator():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return dict(zip(args[::2], args[1::2]))

def hex_rgba(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?', value):
        raise ValueError('Material colors must be #RRGGBB or #RRGGBBAA hex values')
    raw = [int(value[i:i+2], 16) / 255.0 for i in range(1, len(value), 2)]
    if len(raw) == 3: raw.append(1.0)
    return tuple(raw)

def material(name, color):
    mat = bpy.data.materials.new(name=name)
    mat.diffuse_color = hex_rgba(color)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf: bsdf.inputs['Base Color'].default_value = mat.diffuse_color
    return mat

def make_object(item):
    kind = item['primitive']
    collection = {
        'cube': lambda: bpy.ops.mesh.primitive_cube_add(size=2),
        'uv_sphere': lambda: bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16),
        'ico_sphere': lambda: bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3),
        'cylinder': lambda: bpy.ops.mesh.primitive_cylinder_add(vertices=32),
        'cone': lambda: bpy.ops.mesh.primitive_cone_add(vertices=32),
        'torus': lambda: bpy.ops.mesh.primitive_torus_add(major_segments=48, minor_segments=12)
    }
    collection[kind]()
    obj = bpy.context.object
    obj.name = item['id']
    transform = item.get('transform', {})
    obj.location = transform.get('location', (0, 0, 0))
    obj.rotation_euler = transform.get('rotation', (0, 0, 0))
    obj.scale = transform.get('scale', (1, 1, 1))
    obj.data.materials.append(material(item['id'] + '-material', item.get('color', '#72F2C2')))
    for keyframe in item.get('keyframes', []):
        frame = keyframe['frame']
        for prop in ('location', 'rotation', 'scale'):
            if prop in keyframe:
                setattr(obj, 'rotation_euler' if prop == 'rotation' else prop, keyframe[prop])
                obj.keyframe_insert(data_path='rotation_euler' if prop == 'rotation' else prop, frame=frame)
    return obj

def point_at(obj, target):
    obj.rotation_euler = (mathutils.Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

import mathutils
options = args_after_separator()
with open(options['--spec'], 'r', encoding='utf-8') as handle: spec = json.load(handle)
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x = spec['width']; scene.render.resolution_y = spec['height']; scene.render.resolution_percentage = 100
scene.render.fps = spec['fpsNumerator']; scene.render.fps_base = spec['fpsDenominator']
scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_mode = 'RGBA' if spec['alpha'] else 'RGB'; scene.render.film_transparent = spec['alpha']
scene.render.image_settings.color_depth = '8'; scene.render.use_file_extension = True
scene.view_settings.view_transform = 'Standard'; scene.display.shading.light = 'STUDIO'
scene.frame_start = 0; scene.frame_end = spec['durationFrames'] - 1
world = scene.world or bpy.data.worlds.new('Motion Studio World'); scene.world = world; world.color = (0.015, 0.02, 0.04)
camera_data = bpy.data.cameras.new('Motion Studio Camera'); camera = bpy.data.objects.new('Motion Studio Camera', camera_data); scene.collection.objects.link(camera)
camera.location = spec.get('camera', {}).get('location', (0, -9, 2)); camera_data.lens = spec.get('camera', {}).get('lens', 50); scene.camera = camera
camera.rotation_euler = (mathutils.Vector((0, 0, 0)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
for name, location, energy, size in [('Key', (4, -5, 6), 1200, 5), ('Fill', (-4, -2, 3), 500, 4)]:
    data = bpy.data.lights.new(name=name, type='AREA'); data.energy = energy; data.shape = 'DISK'; data.size = size
    obj = bpy.data.objects.new(name, data); scene.collection.objects.link(obj); obj.location = location
    obj.rotation_euler = (mathutils.Vector((0, 0, 0)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
for item in spec['objects']: make_object(item)
os.makedirs(spec['outputDirectory'], exist_ok=True)
for frame in range(scene.frame_start, scene.frame_end + 1):
    scene.frame_set(frame); scene.render.filepath = os.path.join(spec['outputDirectory'], 'frame_')
    bpy.ops.render.render(write_still=True)
with open(spec['metadataPath'], 'w', encoding='utf-8') as handle:
    json.dump({'width': spec['width'], 'height': spec['height'], 'fpsNumerator': spec['fpsNumerator'], 'fpsDenominator': spec['fpsDenominator'], 'durationFrames': spec['durationFrames'], 'alpha': spec['alpha'], 'renderer': 'blender-eevee-next'}, handle, indent=2)
`;

function safeProjectId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('Project id must contain only letters, numbers, underscores or hyphens.');
  return value;
}
function validateVector(value, label, defaults) {
  const vector = value ?? defaults;
  if (!Array.isArray(vector) || vector.length !== 3 || vector.some(part => !Number.isFinite(part))) throw new Error(label + ' must have three finite numeric values.');
  return vector;
}

export function buildBlenderSceneSpec(project, scene, { outputDirectory, metadataPath } = {}) {
  if (!project?.project || !scene?.id || !Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) throw new Error('A valid project and scene with integer-frame duration are required.');
  const fps = project.project.frameRate, canvas = project.project.canvas;
  if (!outputDirectory || !metadataPath) throw new Error('Output frame directory and metadata path are required.');
  if (!Number.isInteger(fps?.numerator) || fps.numerator <= 0 || !Number.isInteger(fps.denominator) || fps.denominator <= 0) throw new Error('Project frame rate must be a positive integer rational.');
  if (!Number.isInteger(canvas?.width) || canvas.width <= 0 || !Number.isInteger(canvas?.height) || canvas.height <= 0) throw new Error('Project canvas needs positive integer dimensions.');
  const layers = (scene.layers || []).filter(layer => layer.kind === '3d' && (!layer.engineHint || ['blender', 'auto'].includes(layer.engineHint)));
  if (!layers.length) throw new Error('Scene has no 3D layers assigned to Blender.');
  const objects = layers.map(layer => {
    const content = layer.content || {};
    const primitive = content.primitive || content.object;
    if (!primitive) throw new Error('3D layer ' + layer.id + ' must declare a supported primitive or use an explicit model asset renderer.');
    if (!OBJECTS.has(primitive)) throw new Error('Unsupported Blender primitive: ' + primitive);
    const color = content.color || layer.style?.color || project.brand?.colors?.primary || project.brand?.colors?.accent;
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) throw new Error('3D layer ' + layer.id + ' must declare a hex color or project brand primary/accent color.');
    const transform = layer.transform3d || content.transform || {};
    const keyframes = content.keyframes || [];
    if (!Array.isArray(keyframes)) throw new Error('3D keyframes must be an array.');
    return {
      id: safeProjectId(layer.id), primitive,
      color,
      transform: {
        location: validateVector(transform.location, 'location', [0, 0, 0]),
        rotation: validateVector(transform.rotation, 'rotation', [0, 0, 0]),
        scale: validateVector(transform.scale, 'scale', [1, 1, 1])
      },
      keyframes: keyframes.map((item, index) => {
        if (!item || typeof item !== 'object') throw new Error('Keyframe ' + index + ' must be an object.');
        if (!Number.isInteger(item.frame) || item.frame < 0 || item.frame >= scene.durationFrames) throw new Error('Keyframe ' + index + ' must fall inside the scene frame range.');
        const key = { frame: item.frame };
        for (const prop of ['location', 'rotation', 'scale']) if (item[prop] !== undefined) key[prop] = validateVector(item[prop], prop, [0, 0, 0]);
        return key;
      })
    };
  });
  const camera = scene.camera || {};
  return {
    schemaVersion: '1.0', projectId: safeProjectId(project.project.id), sceneId: safeProjectId(scene.id),
    width: canvas.width, height: canvas.height, fpsNumerator: fps.numerator, fpsDenominator: fps.denominator,
    durationFrames: scene.durationFrames, alpha: Boolean(scene.outputContract?.alpha),
    camera: { location: validateVector(camera.location, 'camera location', [0, -9, 2]), lens: Number.isFinite(camera.lens) && camera.lens > 0 ? camera.lens : 50 },
    objects, outputDirectory: path.resolve(outputDirectory), metadataPath: path.resolve(metadataPath)
  };
}

export async function renderBlenderScene(project, scene, { projectRoot, signal, onLine = () => {} } = {}) {
  if (!projectRoot) throw new Error('A projectRoot is required for Blender output isolation.');
  const projectId = safeProjectId(project?.project?.id), sceneId = safeProjectId(scene?.id);
  const root = path.resolve(projectRoot), engineRoot = path.join(root, 'engines', 'blender', sceneId);
  const framesDir = path.join(engineRoot, 'frames'), specPath = path.join(engineRoot, 'scene-spec.json'), driverPath = path.join(engineRoot, 'motion-studio-driver.py'), metadataPath = path.join(engineRoot, 'scene-output.json');
  const rootRelative = path.relative(root, engineRoot);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('Blender output path escaped the project root.');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  const spec = buildBlenderSceneSpec(project, scene, { outputDirectory: framesDir, metadataPath });
  await writeFile(specPath, JSON.stringify(spec, null, 2) + '\n');
  await writeFile(driverPath, PYTHON_DRIVER, 'utf8');
  const args = ['--background', '--factory-startup', '--python', driverPath, '--', '--spec', specPath];
  const result = await new Promise((resolve, reject) => {
    const child = spawn('blender', args, { cwd: engineRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8'); stream.on('data', chunk => { if (name === 'stdout') stdout += chunk; else stderr += chunk; onLine({ stream: name, text: chunk }); });
    }
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ code, stdout, stderr }) : reject(new Error('Blender render failed with exit code ' + code + '\n' + (stderr || stdout).slice(-8000))));
  });
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const entries = (await readdir(framesDir)).filter(name => /^frame_\d+\.png$/i.test(name)).sort();
  if (entries.length !== scene.durationFrames) throw new Error('Blender returned ' + entries.length + ' frames; expected ' + scene.durationFrames + '.');
  const evidence = [];
  for (const name of entries) {
    const file = path.join(framesDir, name), info = await stat(file);
    if (!info.isFile() || info.size === 0) throw new Error('Blender emitted an empty frame: ' + name);
    evidence.push({ file, bytes: info.size });
  }
  const firstFramePath = path.join(framesDir, entries[0]);
  const probe = await new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', firstFramePath], { cwd: engineRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error('FFprobe could not inspect the Blender frame: ' + stderr.slice(-4000))));
  });
  const frameMetadata = probe.streams?.[0];
  if (!frameMetadata || frameMetadata.width !== project.project.canvas.width || frameMetadata.height !== project.project.canvas.height) throw new Error('Blender frame dimensions do not match the project canvas.');
  return {
    projectId, sceneId, engine: 'blender', renderer: 'BLENDER_EEVEE_NEXT', frameRate: project.project.frameRate,
    durationFrames: scene.durationFrames, width: metadata.width, height: metadata.height, alpha: metadata.alpha,
    framesDirectory: framesDir, frameCount: evidence.length, firstFrame: evidence[0], lastFrame: evidence[evidence.length - 1],
    frameEvidenceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), frameMetadata, metadata, process: { code: result.code, logTail: (result.stderr || result.stdout).slice(-4000) }, verified: true
  };
}
