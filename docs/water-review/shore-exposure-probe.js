// Close selection preview and stop the game loop. Baseline is the pre-RGBA fetchField module URL.
export async function probe(g, baselineModuleUrl) {
 const T=await import('three/webgpu'),N=await import('three/tsl');
 const {createFetchField,sampleGrid}=await import('/src/ocean/fetchField.ts');
 const old=await import(baselineModuleUrl);
 const {createCaustics}=await import('/src/caustics/index.ts');
 const {buildShoreNodes,createShoreUniforms}=await import('/src/terrain/shoreRunup.ts');
 const {oceanParams:op}=await import('/src/params/ocean.ts');
 const {fetchBandGain,developmentRatio}=await import('/src/ocean/fetch.ts');
 const {swellShadowGain}=await import('/src/ocean/swellShadow.ts');
 const p={...op,fetchFieldSize:128,fetchFieldMargin:1000,fetchBlurTexels:1,windDirection:0,swellDirection:0};
 const bed={origin:[-1000,-1000],size:2000,heightAt:(x,z)=>Math.hypot(x,z)<250?3:-30};
 const cpuTimes=[[],[]];
 for(let r=0;r<6;r++)for(const i of r%2?[1,0]:[0,1]){
  const start=performance.now();const f=(i?createFetchField:old.createFetchField)(bed,{...p,fetchFieldSize:512});
  if(r>0)cpuTimes[i].push(performance.now()-start);f.dispose();
 }
 const field=createFetchField(bed,p),water=createCaustics(g.sea.ocean,{sunLight:g.sea.surface.sunLight});
 water.setFetchField(field);water.update(g.sea.surface.sunLight.position.clone().normalize());
 const size=256,targets=[0,1].map(()=>{const t=new T.StorageTexture(size,size);t.type=T.FloatType;return t;});
 const kernels=targets.map((t,i)=>{
  const u=createShoreUniforms();u.swell.value=g.sea.ocean.heightRms*2;u.time.value=42.6667;
  return N.Fn(()=>{
   const x=N.int(N.instanceIndex).mod(N.int(size)),z=N.int(N.instanceIndex).div(N.int(size));
   const pos=N.vec2(x,z).add(.5).mul(4).sub(512);
   const gain=i?water.waterSurface(pos,N.float(0)).shoreGain:N.float(1);
   const s=buildShoreNodes(u,N.float(.5),pos,gain);
   N.textureStore(t,N.ivec2(x,z),N.vec4(gain,s.level,s.wet,s.foam)).toWriteOnly();
  })().compute(size*size);
 });
 const times=[[],[]],samples=[];
 const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
 try{
  for(let r=0;r<12;r++)for(const i of r%2?[1,0]:[0,1]){
   await g.app.renderer.computeAsync(kernels[i]);await g.app.renderer.resolveTimestampsAsync(T.TimestampQuery.COMPUTE);
   if(r>=4)times[i].push(g.app.renderer.info.compute.timestamp);
  }
  const a=await g.app.renderer.backend.copyTextureToBuffer(targets[1],0,0,size,size,0);
  const packed=field.texture.image.data;
  const fetch=Float32Array.from({length:128*128},(_,i)=>T.DataUtils.fromHalfFloat(packed[i*4+2]));
  const shadow=Float32Array.from({length:128*128},(_,i)=>T.DataUtils.fromHalfFloat(packed[i*4+3]));
  for(const [ix,iz]of [[75,128],[180,128],[128,75],[128,180]]){
   const x=(ix+.5)*4-512,z=(iz+.5)*4-512;
   const f=sampleGrid(fetch,128,field.origin,field.texelSize,x,z),k=sampleGrid(shadow,128,field.origin,field.texelSize,x,z);
   let energy=0,total=0;const u=water.shoaling;
   for(let b=0;b<u.sigma.length;b++){
    const variance=u.sigma[b].value**2;
    const gain=fetchBandGain(u.fetchC[b].value,developmentRatio(f,op.windSpeed,op),op)*swellShadowGain(u.swellShare[b].value,k);
    energy+=variance*gain*gain;total+=variance;
   }
   const cpu=Math.sqrt(energy/Math.max(total,1e-12)),gpu=a[(iz*size+ix)*4];
   if(Math.abs(cpu-gpu)>1e-4)throw Error(`Runup gain CPU/GPU mismatch ${cpu}/${gpu}`);
   samples.push({x,z,fetch:f,shadow:k,cpu,gpu,runupM:a[(iz*size+ix)*4+1]});
  }
  if(samples[0].gpu<=samples[1].gpu)throw Error('Exposed beach must receive more energy than lee');
  return {size,samples,cpuBake512Ms:cpuTimes,cpuBakeMedianMs:cpuTimes.map(median),gpuTimesMs:times,gpuMedianMs:times.map(median),extraCpuBytes512:512*512*8,extraGpuBytes512:512*512*4};
 }finally{targets.forEach(t=>t.dispose());kernels.forEach(k=>k.dispose());field.dispose();}
}
