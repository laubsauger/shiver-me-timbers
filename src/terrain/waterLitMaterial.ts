import * as THREE from 'three/webgpu';

/** Standard terrain lighting with the receiver's water path on specular too. */
class WaterLightingModel extends THREE.PhysicalLightingModel {
  constructor(private readonly attenuation: any) {
    super();
  }

  override finish(builder: THREE.NodeBuilder): void {
    super.finish(builder);
    // r180's type declarations omit the runtime lighting context.
    const { context } = builder as THREE.NodeBuilder & { context: any };
    const { reflectedLight: light, outgoingLight } = context;
    // Diffuse already carries this attenuation through waterLighting.tint.
    // Emissive caustics are added by NodeMaterial AFTER this lighting stage;
    // their own absorption must not be applied twice.
    outgoingLight.assign(
      light.directDiffuse.add(light.indirectDiffuse).add(
        light.directSpecular.add(light.indirectSpecular).mul(this.attenuation),
      ),
    );
  }
}

export class WaterLitMaterial extends THREE.MeshStandardNodeMaterial {
  constructor(public waterAttenuationNode: any) {
    super();
  }

  override setupLightingModel(): THREE.PhysicalLightingModel {
    return new WaterLightingModel(this.waterAttenuationNode);
  }

  override copy(source: this): this {
    super.copy(source);
    this.waterAttenuationNode = source.waterAttenuationNode;
    return this;
  }
}
