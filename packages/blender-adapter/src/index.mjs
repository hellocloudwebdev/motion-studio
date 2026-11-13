import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OBJECTS = new Set(['cube', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus']);
const IMPORT_EXTENSIONS = new Set(['.glb', '.gltf', '.obj']);
const LIGHT_TYPES = new Set(['area', 'point', 'sun']);
const LIGHT_FIELDS = new Set(['type', 'location', 'energy', 'color', 'size']);
const CAMERA_FIELDS = new Set(['location', 'lens', 'rotation', 'keyframes']);
const CAMERA_KEYFRAME_FIELDS = new Set(['frame', 'location', 'rotation']);
const MATERIAL_FIELDS = new Set(['metallic', 'roughness', 'emission']);
const MATERIAL_RANGES = { metallic: [0, 1], roughness: [0, 1], emission: [0, 10] };
const CONTENT_FIELDS = new Set(['primitive', 'object', 'color', 'transform', 'keyframes', 'material']);
const KEYFRAME_FIELDS = new Set(['frame', 'location', 'rotation', 'scale']);
const MAX_LIGHTS = 8;
const MAX_LIGHT_ENERGY = 100000;
const MAX_LIGHT_SIZE = 100;
const PYTHON_DRIVER = String.raw`import bpy, json, os, re, sys
import mathutils

def args_after_separator():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return dict(zip(args[::2], args[1::2]))

def hex_rgba(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?', value):
        raise ValueError('Material colors must be #RRGGBB or #RRGGBBAA hex values')
    raw = [int(value[i:i+2], 16) / 255.0 for i in range(1, len(value), 2)]
    if len(raw) == 3: raw.append(1.0)
    return tuple(raw)

def aim_at(obj, target):
    direction = mathutils.Vector(target) - obj.location
    if direction.length > 0:
        obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

def apply_rotation(obj, rotation):
    # glTF imports carry rotation_mode QUATERNION, where rotation_euler is an
    # inert channel Blender never evaluates; drive the channel the object
    # actually renders with, converting the contract's Euler triple.
    if obj.rotation_mode == 'QUATERNION':
        obj.rotation_quaternion = mathutils.Euler(rotation, 'XYZ').to_quaternion()
        return 'rotation_quaternion'
    obj.rotation_euler = rotation
    return 'rotation_euler'

def apply_material_params(bsdf, item_id, params):
    for key, input_name in (('metallic', 'Metallic'), ('roughness', 'Roughness')):
        if key in params:
            socket = bsdf.inputs.get(input_name)
            if socket is None:
                raise ValueError('Blender Principled BSDF has no ' + input_name + ' input; cannot apply material.' + key + ' on ' + item_id)
            socket.default_value = float(params[key])
    if params.get('emission', 0) > 0:
        strength = bsdf.inputs.get('Emission Strength'); color_socket = bsdf.inputs.get('Emission Color')
        if strength is None or color_socket is None:
            raise ValueError('Blender Principled BSDF has no emission inputs; cannot apply material.emission on ' + item_id)
        strength.default_value = float(params['emission']); color_socket.default_value = bsdf.inputs['Base Color'].default_value

def material(name, color, params=None):
    mat = bpy.data.materials.new(name=name)
    mat.diffuse_color = hex_rgba(color)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF') if mat.node_tree else None
    if bsdf:
        bsdf.inputs['Base Color'].default_value = mat.diffuse_color
        if params: apply_material_params(bsdf, name, params)
    elif params:
        raise ValueError('Blender material has no Principled BSDF node; cannot apply material parameters on ' + name)
    return mat

def keyframe_object(obj, keyframes):
    for keyframe in keyframes:
        frame = keyframe['frame']
        for prop in ('location', 'rotation', 'scale'):
            if prop not in keyframe:
                continue
            if prop == 'rotation':
                obj.keyframe_insert(data_path=apply_rotation(obj, keyframe['rotation']), frame=frame)
            else:
                setattr(obj, prop, keyframe[prop])
                obj.keyframe_insert(data_path=prop, frame=frame)

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
    obj.data.materials.append(material(item['id'] + '-material', item.get('color', '#72F2C2'), item.get('material')))
    keyframe_object(obj, item.get('keyframes', []))
    return obj

def import_asset(item):
    asset = item['asset']
    known = set(bpy.data.objects)
    if asset['format'] == 'obj':
        if hasattr(bpy.ops.import_scene, 'obj'):
            bpy.ops.import_scene.obj(filepath=asset['path'])
        elif hasattr(bpy.ops.wm, 'obj_import'):
            bpy.ops.wm.obj_import(filepath=asset['path'])
        else:
            raise ValueError('Blender build ships no OBJ importer; cannot import ' + asset['path'])
    elif hasattr(bpy.ops.import_scene, 'gltf'):
        bpy.ops.import_scene.gltf(filepath=asset['path'])
    else:
        raise ValueError('Blender build ships no glTF importer; cannot import ' + asset['path'])
    imported = [obj for obj in bpy.data.objects if obj not in known]
    roots = [obj for obj in imported if obj.parent is None or obj.parent in known]
    if not roots:
        raise ValueError('Imported asset produced no root objects: ' + asset['path'])
    target = roots[0]
    if len(roots) > 1:
        empty = bpy.data.objects.new(item['id'], None)
        bpy.context.scene.collection.objects.link(empty)
        for root in roots: root.parent = empty
        target = empty
    transform = item.get('transform', {})
    target.location = transform.get('location', (0, 0, 0))
    apply_rotation(target, transform.get('rotation', (0, 0, 0)))
    target.scale = transform.get('scale', (1, 1, 1))
    keyframe_object(target, item.get('keyframes', []))
    if 'color' in item:
        override = material(item['id'] + '-override-material', item['color'])
        for obj in imported:
            if obj.type == 'MESH':
                for index in range(len(obj.material_slots)):
                    obj.material_slots[index].material = override
    return target

def make_light(index, item):
    kind = item['type']
    data = bpy.data.lights.new(name='Motion Studio Light ' + str(index), type=kind.upper())
    data.energy = item['energy']
    if kind == 'area':
        data.shape = 'DISK'; data.size = item.get('size', 5)
    elif kind == 'point':
        data.shadow_soft_size = item.get('size', 1)
    if 'color' in item: data.color = hex_rgba(item['color'])[:3]
    obj = bpy.data.objects.new(data.name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = item['location']
    aim_at(obj, (0, 0, 0))
    return obj

options = args_after_separator()
with open(options['--spec'], 'r', encoding='utf-8') as handle: spec = json.load(handle)
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
scene = bpy.context.scene
available_engines = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items}
render_engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in available_engines else 'BLENDER_EEVEE'
scene.render.engine = render_engine
scene.render.resolution_x = spec['width']; scene.render.resolution_y = spec['height']; scene.render.resolution_percentage = 100
scene.render.fps = spec['fpsNumerator']; scene.render.fps_base = spec['fpsDenominator']
scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_mode = 'RGBA' if spec['alpha'] else 'RGB'; scene.render.film_transparent = spec['alpha']
scene.render.image_settings.color_depth = '8'; scene.render.use_file_extension = True
scene.view_settings.view_transform = 'Standard'; scene.display.shading.light = 'STUDIO'
scene.frame_start = 0; scene.frame_end = spec['durationFrames'] - 1
world = scene.world or bpy.data.worlds.new('Motion Studio World'); scene.world = world; world.color = (0.015, 0.02, 0.04)
camera_config = spec.get('camera', {})
camera_data = bpy.data.cameras.new('Motion Studio Camera'); camera = bpy.data.objects.new('Motion Studio Camera', camera_data); scene.collection.objects.link(camera)
camera.location = camera_config.get('location', (0, -9, 2)); camera_data.lens = camera_config.get('lens', 50); scene.camera = camera
if 'rotation' in camera_config: camera.rotation_euler = camera_config['rotation']
else: aim_at(camera, (0, 0, 0))
camera_keyframes = camera_config.get('keyframes', [])
if camera_keyframes:
    # Hold the declared base pose until the first keyframe so interpolation is
    # deterministic instead of jumping to the first key value on frame 0.
    if all(keyframe['frame'] != 0 for keyframe in camera_keyframes):
        camera.keyframe_insert(data_path='location', frame=0)
        camera.keyframe_insert(data_path='rotation_euler', frame=0)
    for keyframe in camera_keyframes:
        frame = keyframe['frame']
        if 'location' in keyframe:
            camera.location = keyframe['location']
            camera.keyframe_insert(data_path='location', frame=frame)
            if 'rotation' not in keyframe:
                aim_at(camera, (0, 0, 0))
                camera.keyframe_insert(data_path='rotation_euler', frame=frame)
        if 'rotation' in keyframe:
            camera.rotation_euler = keyframe['rotation']
            camera.keyframe_insert(data_path='rotation_euler', frame=frame)
lighting = spec.get('lighting') or {}
if lighting.get('lights'):
    for index, item in enumerate(lighting['lights']): make_light(index + 1, item)
else:
    for name, location, energy, size in [('Key', (4, -5, 6), 1200, 5), ('Fill', (-4, -2, 3), 500, 4)]:
        data = bpy.data.lights.new(name=name, type='AREA'); data.energy = energy; data.shape = 'DISK'; data.size = size
        obj = bpy.data.objects.new(name, data); scene.collection.objects.link(obj); obj.location = location
        aim_at(obj, (0, 0, 0))
for item in spec['objects']:
    import_asset(item) if 'asset' in item else make_object(item)
os.makedirs(spec['outputDirectory'], exist_ok=True)
single_frame = spec.get('singleFrame')
start = scene.frame_start if single_frame is None else int(single_frame)
end = scene.frame_end if single_frame is None else int(single_frame)
# Fault injection hook (MOTION_STUDIO_SKIP_FRAME / _SKIP_MODE) exists only so
# tests can simulate failed frames and exercise the recovery pass; production
# environments never set these variables.
skip_frame = os.environ.get('MOTION_STUDIO_SKIP_FRAME')
skip_mode = os.environ.get('MOTION_STUDIO_SKIP_MODE', 'once')
fault_marker = os.path.join(spec['outputDirectory'], 'fault-pass-marker')
for frame in range(start, end + 1):
    scene.frame_set(frame)
    if skip_frame is not None and str(frame) == skip_frame.strip() and (skip_mode == 'always' or not os.path.exists(fault_marker)):
        open(fault_marker, 'w').close()
        continue
    scene.render.filepath = os.path.join(spec['outputDirectory'], 'frame_' + str(frame).zfill(4))
    bpy.ops.render.render(write_still=True)
with open(spec['metadataPath'], 'w', encoding='utf-8') as handle:
    json.dump({'width': spec['width'], 'height': spec['height'], 'fpsNumerator': spec['fpsNumerator'], 'fpsDenominator': spec['fpsDenominator'], 'durationFrames': spec['durationFrames'], 'alpha': spec['alpha'], 'renderer': render_engine, 'blenderVersion': bpy.app.version_string}, handle, indent=2)
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
function rejectIfMalformed(value, label) {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error(label + ' must be an object when provided.');
}
function validateHexColor(value, label) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) throw new Error(label + ' must be a #RRGGBB or #RRGGBBAA hex value.');
  return value;
}
function validatedTransform(transform, label) {
  return {
    location: validateVector(transform.location, label + ' location', [0, 0, 0]),
    rotation: validateVector(transform.rotation, label + ' rotation', [0, 0, 0]),
    scale: validateVector(transform.scale, label + ' scale', [1, 1, 1])
  };
}
function validateKeyframes(keyframes, label, durationFrames, allowedFields) {
  if (keyframes === undefined) return [];
  if (!Array.isArray(keyframes)) throw new Error(label + ' must be an array.');
  return keyframes.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(label + ' entry ' + index + ' must be an object.');
    const unknown = Object.keys(item).filter(key => !allowedFields.has(key));
    if (unknown.length) throw new Error(label + ' entry ' + index + ' declares unsupported fields: ' + unknown.join(', ') + '.');
    if (!Number.isInteger(item.frame) || item.frame < 0 || item.frame >= durationFrames) throw new Error(label + ' entry ' + index + ' must fall inside the scene frame range (0-' + (durationFrames - 1) + ').');
    const key = { frame: item.frame };
    for (const prop of allowedFields) if (prop !== 'frame' && item[prop] !== undefined) key[prop] = validateVector(item[prop], label + ' entry ' + index + ' ' + prop, [0, 0, 0]);
    return key;
  });
}
function validateCamera(camera, durationFrames) {
  if (camera === undefined || camera === null) return { location: [0, -9, 2], lens: 50 };
  rejectIfMalformed(camera, 'Scene camera');
  const unknown = Object.keys(camera).filter(key => !CAMERA_FIELDS.has(key));
  if (unknown.length) {
    if (unknown.includes('fov')) throw new Error('Blender camera contract does not support fov; declare lens (millimetres) instead.');
    throw new Error('Scene camera declares unsupported fields: ' + unknown.join(', ') + '. Supported fields: ' + [...CAMERA_FIELDS].join(', ') + '.');
  }
  const cameraSpec = {
    location: validateVector(camera.location, 'Camera location', [0, -9, 2]),
    lens: Number.isFinite(camera.lens) && camera.lens > 0 ? camera.lens : 50
  };
  if (camera.rotation !== undefined) cameraSpec.rotation = validateVector(camera.rotation, 'Camera rotation', [0, 0, 0]);
  if (camera.keyframes !== undefined) {
    cameraSpec.keyframes = validateKeyframes(camera.keyframes, 'Camera keyframes', durationFrames, CAMERA_KEYFRAME_FIELDS);
    cameraSpec.keyframes.forEach((key, index) => {
      if (key.location === undefined && key.rotation === undefined) throw new Error('Camera keyframe ' + index + ' must declare location or rotation.');
    });
  }
  return cameraSpec;
}
function validateLighting(lighting) {
  if (lighting === undefined || lighting === null) return null;
  rejectIfMalformed(lighting, 'Scene lighting');
  const unknown = Object.keys(lighting).filter(key => key !== 'lights');
  if (unknown.length) throw new Error('Scene lighting declares unsupported fields: ' + unknown.join(', ') + '. Supported fields: lights.');
  if (!Array.isArray(lighting.lights) || lighting.lights.length === 0) throw new Error('Scene lighting.lights must be a non-empty array of light definitions.');
  if (lighting.lights.length > MAX_LIGHTS) throw new Error('Scene lighting supports at most ' + MAX_LIGHTS + ' lights per scene; received ' + lighting.lights.length + '.');
  return { lights: lighting.lights.map((item, index) => {
    const ordinal = index + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Light ' + ordinal + ' must be an object.');
    const lightUnknown = Object.keys(item).filter(key => !LIGHT_FIELDS.has(key));
    if (lightUnknown.length) throw new Error('Light ' + ordinal + ' declares unsupported fields: ' + lightUnknown.join(', ') + '. Supported fields: type, location, energy, color, size.');
    if (!LIGHT_TYPES.has(item.type)) throw new Error('Light ' + ordinal + ' has unsupported type ' + JSON.stringify(item.type) + '. Supported types: area, point, sun.');
    if (!Number.isFinite(item.energy) || item.energy <= 0 || item.energy > MAX_LIGHT_ENERGY) throw new Error('Light ' + ordinal + ' energy must be a finite number between 0 and ' + MAX_LIGHT_ENERGY + ' watts.');
    if (item.size !== undefined && item.type === 'sun') throw new Error('Light ' + ordinal + ' is a sun light; size is unsupported because sun direction comes from its location relative to the origin.');
    const light = {
      id: 'light-' + ordinal, type: item.type,
      location: validateVector(item.location, 'Light ' + ordinal + ' location'),
      energy: item.energy
    };
    if (item.color !== undefined) light.color = validateHexColor(item.color, 'Light ' + ordinal + ' color');
    if (item.size !== undefined) {
      if (!Number.isFinite(item.size) || item.size <= 0 || item.size > MAX_LIGHT_SIZE) throw new Error('Light ' + ordinal + ' size must be a finite number between 0 and ' + MAX_LIGHT_SIZE + '.');
      light.size = item.size;
    }
    return light;
  }) };
}
function validateMaterial(material, label) {
  if (material === undefined || material === null) return null;
  rejectIfMalformed(material, label);
  const unknown = Object.keys(material).filter(key => !MATERIAL_FIELDS.has(key));
  if (unknown.length) throw new Error(label + ' declares unsupported fields: ' + unknown.join(', ') + '. Supported fields: metallic, roughness, emission.');
  const validated = {};
  for (const [key, [min, max]] of Object.entries(MATERIAL_RANGES)) {
    const value = material[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(label + '.' + key + ' must be a finite number between ' + min + ' and ' + max + '.');
    validated[key] = value;
  }
  return Object.keys(validated).length ? validated : null;
}
function buildPrimitiveObject(layer, content, transform, keyframes, materialParams, project) {
  const primitive = content.primitive || content.object;
  if (!primitive) throw new Error('3D layer ' + layer.id + ' must declare a supported primitive or reference an imported asset with layer.assetId.');
  if (!OBJECTS.has(primitive)) throw new Error('Unsupported Blender primitive: ' + primitive);
  const color = content.color || layer.style?.color || project.brand?.colors?.primary || project.brand?.colors?.accent;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) throw new Error('3D layer ' + layer.id + ' must declare a hex color or project brand primary/accent color.');
  const object = { id: safeProjectId(layer.id), primitive, color, transform: validatedTransform(transform, '3D layer ' + layer.id), keyframes };
  if (materialParams) object.material = materialParams;
  return object;
}
function buildAssetObject(layer, content, transform, keyframes, materialParams, project, projectRoot) {
  if (materialParams) throw new Error('3D layer ' + layer.id + ' imports an asset; material parameter overrides apply only to procedural primitives (a color override is supported).');
  if (content.primitive || content.object) throw new Error('3D layer ' + layer.id + ' cannot declare both assetId and a primitive; imported assets replace procedural geometry.');
  if (typeof layer.assetId !== 'string' || !layer.assetId.trim()) throw new Error('3D layer ' + layer.id + ' assetId must be a non-empty string when provided.');
  if (!projectRoot) throw new Error('3D layer ' + layer.id + ' references asset ' + layer.assetId + ' but no projectRoot was provided to resolve imported assets.');
  const asset = (Array.isArray(project.assets) ? project.assets : []).find(item => item?.id === layer.assetId);
  if (!asset) throw new Error('3D layer ' + layer.id + ' references assetId ' + layer.assetId + ' that is not declared in project.assets.');
  if (typeof asset.uri !== 'string' || !asset.uri.trim()) throw new Error('Asset ' + layer.assetId + ' must declare a non-empty uri path.');
  const uri = asset.uri.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || path.isAbsolute(uri) || path.win32.isAbsolute(uri)) throw new Error('Asset ' + layer.assetId + ' uri must be a project-relative path without a scheme; received: ' + uri);
  const extension = path.extname(uri).toLowerCase();
  if (!IMPORT_EXTENSIONS.has(extension)) throw new Error('Asset ' + layer.assetId + ' declares unsupported imported-asset extension ' + (extension || '(none)') + '. Blender imports .glb, .gltf and .obj only.');
  const resolved = path.resolve(projectRoot, uri);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Asset ' + layer.assetId + ' uri escapes the project root: ' + uri);
  const object = {
    id: safeProjectId(layer.id),
    asset: { assetId: layer.assetId, uri: relative.split(path.sep).join('/'), format: extension === '.obj' ? 'obj' : 'gltf', path: resolved },
    transform: validatedTransform(transform, '3D layer ' + layer.id),
    keyframes
  };
  const color = content.color || layer.style?.color;
  if (color !== undefined) object.color = validateHexColor(color, '3D layer ' + layer.id + ' color override');
  return object;
}

export function buildBlenderSceneSpec(project, scene, { outputDirectory, metadataPath, projectRoot } = {}) {
  if (!project?.project || !scene?.id || !Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) throw new Error('A valid project and scene with integer-frame duration are required.');
  const fps = project.project.frameRate, canvas = project.project.canvas;
  if (!outputDirectory || !metadataPath) throw new Error('Output frame directory and metadata path are required.');
  if (!Number.isInteger(fps?.numerator) || fps.numerator <= 0 || !Number.isInteger(fps.denominator) || fps.denominator <= 0) throw new Error('Project frame rate must be a positive integer rational.');
  if (!Number.isInteger(canvas?.width) || canvas.width <= 0 || !Number.isInteger(canvas?.height) || canvas.height <= 0) throw new Error('Project canvas needs positive integer dimensions.');
  const layers = (scene.layers || []).filter(layer => layer.kind === '3d' && (!layer.engineHint || ['blender', 'auto'].includes(layer.engineHint)));
  if (!layers.length) throw new Error('Scene has no 3D layers assigned to Blender.');
  const objects = layers.map(layer => {
    const content = layer.content || {};
    rejectIfMalformed(content, '3D layer ' + layer.id + ' content');
    const unknownContent = Object.keys(content).filter(key => !CONTENT_FIELDS.has(key));
    if (unknownContent.length) {
      const hint = unknownContent.includes('assetId') ? ' Declare assetId on the layer itself (layer.assetId), not inside content.' : '';
      throw new Error('3D layer ' + layer.id + ' declares unsupported content fields: ' + unknownContent.join(', ') + '. Supported content fields: ' + [...CONTENT_FIELDS].join(', ') + '.' + hint);
    }
    const transform = layer.transform3d || content.transform || {};
    const keyframes = validateKeyframes(content.keyframes, '3D keyframes for layer ' + layer.id, scene.durationFrames, KEYFRAME_FIELDS);
    const materialParams = validateMaterial(content.material, '3D layer ' + layer.id + ' material');
    if (layer.assetId !== undefined && layer.assetId !== null) return buildAssetObject(layer, content, transform, keyframes, materialParams, project, projectRoot);
    return buildPrimitiveObject(layer, content, transform, keyframes, materialParams, project);
  });
  const outputContract = scene.outputContract;
  if (outputContract !== undefined && outputContract !== null && (typeof outputContract !== 'object' || Array.isArray(outputContract))) throw new Error('Scene outputContract must be an object when provided.');
  if (outputContract?.alpha !== undefined && typeof outputContract.alpha !== 'boolean') throw new Error('Scene outputContract.alpha must be a boolean when provided.');
  const lighting = validateLighting(scene.lighting);
  return {
    schemaVersion: '1.0', projectId: safeProjectId(project.project.id), sceneId: safeProjectId(scene.id),
    width: canvas.width, height: canvas.height, fpsNumerator: fps.numerator, fpsDenominator: fps.denominator,
    durationFrames: scene.durationFrames, alpha: Boolean(outputContract?.alpha),
    camera: validateCamera(scene.camera, scene.durationFrames),
    ...(lighting ? { lighting } : {}),
    objects, outputDirectory: path.resolve(outputDirectory), metadataPath: path.resolve(metadataPath)
  };
}

export function planBlenderFrameRecovery(durationFrames, frames) {
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) throw new Error('durationFrames must be a positive integer.');
  if (!Array.isArray(frames)) throw new Error('frames must be an array of { frame, bytes } records.');
  const usable = new Map();
  for (const record of frames) {
    if (!record || !Number.isInteger(record.frame) || record.frame < 0 || !Number.isFinite(record.bytes)) throw new Error('frames must be an array of { frame, bytes } records.');
    if (record.bytes > 0) usable.set(record.frame, record);
  }
  const expected = Array.from({ length: durationFrames }, (_, index) => index);
  return {
    recovered: expected.filter(frame => usable.has(frame)),
    missing: expected.filter(frame => !usable.has(frame)),
    unexpected: frames.map(record => record.frame).filter(frame => frame >= durationFrames)
  };
}

function blenderEnginePaths(root, sceneId) {
  const engineRoot = path.join(root, 'engines', 'blender', sceneId);
  return {
    engineRoot,
    framesDir: path.join(engineRoot, 'frames'),
    specPath: path.join(engineRoot, 'scene-spec.json'),
    driverPath: path.join(engineRoot, 'motion-studio-driver.py'),
    metadataPath: path.join(engineRoot, 'scene-output.json')
  };
}

// Containment + regular-file verification for imported assets, mirroring the
// asset-registry conventions (no symlinks anywhere along the relative path).
async function assertImportedAssetFile(root, asset) {
  const relative = path.relative(root, asset.path);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Imported asset path escapes the project root: ' + asset.uri);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch { throw new Error('Imported asset file is missing: ' + current); }
    if (info.isSymbolicLink()) throw new Error('Imported asset path must not traverse symlinks: ' + asset.uri);
  }
  const info = await lstat(asset.path);
  if (!info.isFile()) throw new Error('Imported asset must be a regular file: ' + asset.path);
}

async function collectFrameEvidence(framesDir, durationFrames) {
  const names = (await readdir(framesDir)).filter(name => /^frame_\d+\.png$/i.test(name)).sort();
  const records = [];
  for (const name of names) {
    const file = path.join(framesDir, name);
    const info = await stat(file);
    records.push({ frame: Number(name.slice('frame_'.length, -'.png'.length)), bytes: info.isFile() ? info.size : 0, file });
  }
  const plan = planBlenderFrameRecovery(durationFrames, records);
  const byFrame = new Map(records.map(record => [record.frame, record]));
  return {
    evidence: plan.recovered.map(frame => ({ file: byFrame.get(frame).file, bytes: byFrame.get(frame).bytes })),
    missing: plan.missing,
    unexpected: plan.unexpected
  };
}

async function runBlender({ engineRoot, specPath, driverPath, threads, signal, onLine }) {
  const args = ['--background', '--factory-startup'];
  if (threads !== undefined) args.push('--threads', String(threads));
  args.push('--python', driverPath, '--', '--spec', specPath);
  return await new Promise((resolve, reject) => {
    const child = spawn('blender', args, { cwd: engineRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8'); stream.on('data', chunk => { if (name === 'stdout') stdout += chunk; else stderr += chunk; onLine({ stream: name, text: chunk }); });
    }
    child.once('error', error => reject(error.name === 'AbortError' ? new Error('Blender render aborted via AbortSignal.') : error));
    child.once('close', code => {
      if (signal?.aborted) return reject(new Error('Blender render aborted via AbortSignal.'));
      code === 0 ? resolve({ code, stdout, stderr }) : reject(new Error('Blender render failed with exit code ' + code + '\n' + (stderr || stdout).slice(-8000)));
    });
  });
}

export async function renderBlenderScene(project, scene, { projectRoot, signal, onLine = () => {}, threads } = {}) {
  if (!projectRoot) throw new Error('A projectRoot is required for Blender output isolation.');
  const projectId = safeProjectId(project?.project?.id), sceneId = safeProjectId(scene?.id);
  const root = path.resolve(projectRoot), { engineRoot, framesDir, specPath, driverPath, metadataPath } = blenderEnginePaths(root, sceneId);
  const rootRelative = path.relative(root, engineRoot);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('Blender output path escaped the project root.');
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1 || threads > 64)) throw new Error('threads must be a positive integer when provided.');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  const spec = buildBlenderSceneSpec(project, scene, { outputDirectory: framesDir, metadataPath, projectRoot: root });
  for (const object of spec.objects) if (object.asset) await assertImportedAssetFile(root, object.asset);
  await writeFile(specPath, JSON.stringify(spec, null, 2) + '\n');
  await writeFile(driverPath, PYTHON_DRIVER, 'utf8');
  const result = await runBlender({ engineRoot, specPath, driverPath, threads, signal, onLine });
  let { evidence, missing, unexpected } = await collectFrameEvidence(framesDir, scene.durationFrames);
  if (unexpected.length) throw new Error('Blender emitted frames outside the scene duration: ' + unexpected.join(', ') + '.');
  const retriedFrames = [];
  let lastRecoveryError = null;
  if (missing.length) {
    // Recovery pass: each missing or empty frame is re-rendered exactly once
    // in single-frame mode; sibling frames already on disk are untouched. A
    // failed retry is recorded and the loop continues so the final error can
    // list every frame that is still missing.
    for (const frame of missing) {
      if (signal?.aborted) throw new Error('Blender render aborted via AbortSignal.');
      retriedFrames.push(frame);
      try {
        await renderBlenderFrame(project, scene, { projectRoot: root, frame, signal, onLine, threads });
      } catch (error) {
        if (signal?.aborted) throw new Error('Blender render aborted via AbortSignal.');
        lastRecoveryError = error;
      }
      ({ evidence, missing, unexpected } = await collectFrameEvidence(framesDir, scene.durationFrames));
      if (unexpected.length) throw new Error('Blender emitted frames outside the scene duration: ' + unexpected.join(', ') + '.');
    }
    await writeFile(specPath, JSON.stringify(spec, null, 2) + '\n');
  }
  if (missing.length) {
    const detail = lastRecoveryError ? ' Last recovery error: ' + lastRecoveryError.message : '';
    throw new Error('Blender frames failed after one recovery pass: frames ' + missing.join(', ') + ' are still missing or empty.' + detail);
  }
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const firstFramePath = evidence[0].file;
  const probe = await new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,pix_fmt', '-of', 'json', firstFramePath], { cwd: engineRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error('FFprobe could not inspect the Blender frame: ' + stderr.slice(-4000))));
  });
  const frameMetadata = probe.streams?.[0];
  if (!frameMetadata || frameMetadata.width !== project.project.canvas.width || frameMetadata.height !== project.project.canvas.height) throw new Error('Blender frame dimensions do not match the project canvas.');
  return {
    projectId, sceneId, engine: 'blender', renderer: metadata.renderer, blenderVersion: metadata.blenderVersion, threads: threads ?? null, frameRate: project.project.frameRate,
    durationFrames: scene.durationFrames, width: metadata.width, height: metadata.height, alpha: metadata.alpha,
    framesDirectory: framesDir, frameCount: evidence.length, firstFrame: evidence[0], lastFrame: evidence[evidence.length - 1], retriedFrames,
    frameEvidenceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), frameMetadata, metadata, process: { code: result.code, logTail: (result.stderr || result.stdout).slice(-4000) }, verified: true
  };
}

// Recovery primitive: re-render exactly one frame of a scene into the standard
// frames directory using the driver's single-frame spec flag. Used by the
// renderBlenderScene recovery pass and available for targeted re-renders.
export async function renderBlenderFrame(project, scene, { projectRoot, frame, signal, onLine = () => {}, threads } = {}) {
  if (!projectRoot) throw new Error('A projectRoot is required for Blender output isolation.');
  if (!Number.isInteger(frame) || frame < 0) throw new Error('frame must be a non-negative integer.');
  if (!Number.isInteger(scene?.durationFrames) || frame >= scene.durationFrames) throw new Error('frame ' + frame + ' falls outside the scene duration.');
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1 || threads > 64)) throw new Error('threads must be a positive integer when provided.');
  const projectId = safeProjectId(project?.project?.id), sceneId = safeProjectId(scene?.id);
  const root = path.resolve(projectRoot), { engineRoot, framesDir, specPath, driverPath, metadataPath } = blenderEnginePaths(root, sceneId);
  const rootRelative = path.relative(root, engineRoot);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('Blender output path escaped the project root.');
  const spec = buildBlenderSceneSpec(project, scene, { outputDirectory: framesDir, metadataPath, projectRoot: root });
  for (const object of spec.objects) if (object.asset) await assertImportedAssetFile(root, object.asset);
  await mkdir(framesDir, { recursive: true });
  await writeFile(specPath, JSON.stringify({ ...spec, singleFrame: frame }, null, 2) + '\n');
  await writeFile(driverPath, PYTHON_DRIVER, 'utf8');
  await runBlender({ engineRoot, specPath, driverPath, threads, signal, onLine });
  const file = path.join(framesDir, 'frame_' + String(frame).padStart(4, '0') + '.png');
  let info;
  try { info = await stat(file); }
  catch { throw new Error('Blender single-frame render produced no usable frame ' + frame + ' at ' + file); }
  if (!info.isFile() || info.size === 0) throw new Error('Blender single-frame render produced no usable frame ' + frame + ' at ' + file);
  return { projectId, sceneId, engine: 'blender', frame, file, bytes: info.size, verified: true };
}
