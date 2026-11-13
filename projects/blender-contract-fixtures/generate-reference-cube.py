import bpy, os

# Generates assets/models/reference-cube.glb for the blender-contract-fixtures
# project. Run from the project directory with:
#   blender --background --factory-startup --python generate-reference-cube.py
# Provenance: generated locally with Blender 5.3.0 via bpy.ops.export_scene.gltf;
# a plain default-size cube with one Principled material. No external assets or
# third-party files are involved.

OUTPUT = os.path.join('assets', 'models', 'reference-cube.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
cube = bpy.context.object
material = bpy.data.materials.new('FixtureCubeMaterial')
material.use_nodes = True
cube.data.materials.append(material)
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUTPUT, export_format='GLB', use_selection=False)
print('WROTE ' + OUTPUT + ' (' + str(os.path.getsize(OUTPUT)) + ' bytes)')
