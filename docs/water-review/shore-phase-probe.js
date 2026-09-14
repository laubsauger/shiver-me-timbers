// Run in a browser with the game loop stopped. Supply the pre-fix shoreRunup module URL.
export async function probe(renderer, baselineModuleUrl) {
 const T=await import('three/webgpu'), N=await import('three/tsl');
 const modules=await Promise.all([import(baselineModuleUrl),import('/src/terrain/shoreRunup.ts')]);
 const size=512, cell=.02;
 const targets=modules.map(()=>{const t=new T.StorageTexture(size,size);t.type=T.FloatType;return t;});
 const kernels=modules.map((m,i)=>{
  const u=m.createShoreUniforms();u.time.value=42.6666667;u.swell.value=4.801022;
  return N.Fn(()=>{
   const x=N.int(N.instanceIndex).mod(N.int(size)), z=N.int(N.instanceIndex).div(N.int(size));
   const world=N.vec2(x,z).mul(cell).add(N.vec2(3,-269));
   const s=m.buildShoreNodes(u,N.float(.8),world);
   N.textureStore(targets[i],N.ivec2(x,z),N.vec4(s.sheet,s.wet,s.foam,s.level)).toWriteOnly();
  })().compute(size*size);
 });
 const times=[[],[]], stats=[];
 try {
  for(let round=0;round<15;round++)for(const i of round%2?[1,0]:[0,1]){
   await renderer.computeAsync(kernels[i]);await renderer.resolveTimestampsAsync(T.TimestampQuery.COMPUTE);
   if(round>=5)times[i].push(renderer.info.compute.timestamp);
  }
  for(const target of targets){
   const a=await renderer.backend.copyTextureToBuffer(target,0,0,size,size,0);
   let max=0,sum=0,count=0, jumps=0;
   for(let z=0;z<size;z++)for(let x=1;x<size;x++){
    const delta=Math.abs(a[(z*size+x)*4+3]-a[(z*size+x-1)*4+3]);
    max=Math.max(max,delta);sum+=delta;count++;if(delta>.02)jumps++;
   }
   stats.push({maxAdjacentHeightM:max,meanAdjacentHeightM:sum/count,jumpsAbove2cm:jumps,samples:count});
  }
  if (stats[1].maxAdjacentHeightM > 0.005) throw new Error('Swash height discontinuity exceeds 5 mm over 2 cm');
  const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
  return {grid:size,cellM:cell,timesMs:times,medianMs:times.map(median),stats};
 } finally {targets.forEach(t=>t.dispose());kernels.forEach(k=>k.dispose());}
}
