// Close the selection preview AND stop the game loop before timing. Supply the pre-decay-fix module URL.
export async function probe(renderer, baselineModuleUrl) {
 const T=await import('three/webgpu'),N=await import('three/tsl');
 const modules=await Promise.all([import(baselineModuleUrl),import('/src/terrain/shoreRunup.ts')]);
 const size=256, cases=[[0,1],[0,30],[1,1],[1,30]], targets=[],kernels=[],times=cases.map(()=>[]);
 for(const [index,dry]of cases){
  const target=new T.StorageTexture(size,size);target.type=T.FloatType;targets.push(target);
  const m=modules[index],u=m.createShoreUniforms();u.swell.value=4.8;u.dryTime.value=dry;
  kernels.push(N.Fn(()=>{
   const x=N.int(N.instanceIndex).mod(N.int(size)),z=N.int(N.instanceIndex).div(N.int(size));
   u.time=N.float(z).div(size).add(6).mul(u.period);
   const s=m.buildShoreNodes(u,N.float(x).div(size).mul(6),N.vec2(3,-269));
   N.textureStore(target,N.ivec2(x,z),N.vec4(s.sheet,s.wet,s.foam,s.level)).toWriteOnly();
  })().compute(size*size));
 }
 try {
  for(let round=0;round<12;round++)for(const i of round%2?[3,2,1,0]:[0,1,2,3]){
   await renderer.computeAsync(kernels[i]);await renderer.resolveTimestampsAsync(T.TimestampQuery.COMPUTE);
   if(round>=4)times[i].push(renderer.info.compute.timestamp);
  }
  const arrays=[];
  for(const t of targets)arrays.push(await renderer.backend.copyTextureToBuffer(t,0,0,size,size,0));
  const difference=(a,b,c)=>{let max=0,sum=0;for(let i=c;i<a.length;i+=4){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);sum+=d;}return {max,mean:sum/(a.length/4)};};
  const before=difference(arrays[0],arrays[1],2),after=difference(arrays[2],arrays[3],2),wet=difference(arrays[2],arrays[3],1);
  if(after.max>1e-6)throw Error('Foam lifetime still depends on sand drying time');
  if(wet.max<.1)throw Error('Probe failed to exercise wet-sand memory');
  let count=0, residualBefore=0, residualAfter=0, residualPeak=0;
  for(let z=0;z<size;z++)for(let x=0;x<size;x++){
   const i=(z*size+x)*4,height=x/size*6;
   if(height<=arrays[3][i+3]+.3 || arrays[3][i]>.01 || arrays[3][i+1]<.8)continue;
   count++;residualBefore+=arrays[1][i+2];residualAfter+=arrays[3][i+2];residualPeak=Math.max(residualPeak,arrays[3][i+2]);
  }
  if(!count || residualPeak<.001 || residualAfter>=residualBefore)throw Error('Stranded foam must survive briefly, then fade before wet sand');
  const residue={samples:count,meanBefore:residualBefore/count,meanAfter:residualAfter/count,peakAfter:residualPeak};
  const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
  return {size,cases,residue,foamDifferenceBefore:before,foamDifferenceAfter:after,wetDifference:wet,medianMs:times.map(median),timesMs:times};
 }finally{targets.forEach(t=>t.dispose());kernels.forEach(k=>k.dispose());}
}
