/** Run with an initialized renderer; verifies actual Three DOF background handling. */
export async function probe(renderer) {
  const T = await import('three/webgpu'), N = await import('three/tsl');
  const { dof } = await import('three/addons/tsl/display/DepthOfFieldNode.js');
  const { skyDof } = await import('/src/core/skyDof.ts');
  const width=128,height=64,data=new Float32Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=(y*width+x)*4,star=x%11===5&&y%11===5;
    data[i]=data[i+1]=data[i+2]=star?1:0;data[i+3]=1;
  }
  const source=new T.DataTexture(data,width,height,T.RGBAFormat,T.FloatType);source.needsUpdate=true;
  const color=N.texture(source), sky=N.uv().x.lessThan(.5);
  const depth=N.select(sky,N.float(1),N.float(.5)),viewZ=N.select(sky,N.float(-1000),N.float(-100));
  const focus=N.float(20),range=N.float(15),bokeh=N.float(2);
  const nodes=[color,dof(color,viewZ,focus,range,bokeh),skyDof(color,depth,viewZ,focus,range,bokeh)];
  const materials=nodes.map(output=>{const m=new T.MeshBasicNodeMaterial();m.outputNode=output;m.toneMapped=false;return m;});
  const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),mesh=new T.Mesh(geometry,materials[0]);scene.add(mesh);
  const camera=new T.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=2;
  const target=new T.RenderTarget(width,height,{type:T.FloatType,depthBuffer:false}),previous=renderer.getRenderTarget(),arrays=[];
  try {
    for(const material of materials){mesh.material=material;renderer.setRenderTarget(target);await renderer.renderAsync(scene,camera);arrays.push(await renderer.backend.copyTextureToBuffer(target.texture,0,0,width,height,0));}
    let oldSkyError=0,newSkyError=0,geometryBlur=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=(y*width+x)*4;
      if(x<60){oldSkyError=Math.max(oldSkyError,Math.abs(arrays[1][i]-arrays[0][i]));newSkyError=Math.max(newSkyError,Math.abs(arrays[2][i]-arrays[0][i]));}
      if(x>84)geometryBlur=Math.max(geometryBlur,Math.abs(arrays[2][i]-arrays[0][i]));
    }
    if(oldSkyError<.1||newSkyError>1e-6||geometryBlur<.1)throw Error(JSON.stringify({oldSkyError,newSkyError,geometryBlur}));
    return {width,height,oldSkyError,newSkyError,geometryBlur};
  }finally{renderer.setRenderTarget(previous);target.dispose();geometry.dispose();source.dispose();materials.forEach(m=>m.dispose());}
}
