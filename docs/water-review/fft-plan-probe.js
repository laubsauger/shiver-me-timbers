/** Compare the retained CPU plan to a supplied pre-plan 2D transform module. */
export async function probeFFTPlan(baseline) {
  const { cpuIFFT2D } = baseline;
  const { createCpuIFFT2D } = await import('../../src/sea-physics/cpuFft.ts');
  const { generateButterfly } = await import('../../src/ocean/oceanMath.ts');
  const results=[];
  for(const n of [64,128]) {
    const table=generateButterfly(n), planned=createCpuIFFT2D(table,n);
    const src={re:Float32Array.from({length:n*n},(_,i)=>Math.sin(i*.31)),im:Float32Array.from({length:n*n},(_,i)=>Math.cos(i*.17))};
    const a={re:new Float32Array(n*n),im:new Float32Array(n*n)},b={re:new Float32Array(n*n),im:new Float32Array(n*n)};
    const reset=g=>{g.re.set(src.re);g.im.set(src.im);}; reset(a);reset(b);
    cpuIFFT2D(a,table,n);planned(b);
    for(const key of ['re','im']) {const aa=new Uint32Array(a[key].buffer),bb=new Uint32Array(b[key].buffer);for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])throw new Error(`FFT mismatch ${n}/${key}/${i}`);}
    const samples=[[],[]];
    for(let round=0;round<48;round++)for(const k of round%2?[1,0]:[0,1]){const grid=[a,b][k];reset(grid);const start=performance.now();if(k)planned(grid);else cpuIFFT2D(grid,table,n);if(round>=8)samples[k].push(performance.now()-start);}
    results.push({n,bitIdentical:true,medianMs:samples.map(s=>s.sort((a,b)=>a-b)[Math.floor(s.length/2)])});
  }
  return results;
}
