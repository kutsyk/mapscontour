// Starts its own loopback API on port 4312 and exits after verification.
process.env.NODE_ENV='test';
process.env.MAPSCONTOUR_TEST_PORT='4312';
await import('../server/index.mjs');
import assert from 'node:assert/strict';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
  await delay(150);
  const base='http://127.0.0.1:4312/api';
  const sources=await (await fetch(base+'/sources')).json();
  assert(sources.some(s=>s.id==='mapterhorn'&&s.resolution===null));
  const post=async(url,body)=>{
    const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const v=await r.json();if(!r.ok)throw Error(v.error);return v;
  };
  const bounds=[-121.98,46.8,-121.67,47];
  const preview=await post('/preview',{bounds,sourceId:'sample'});
  assert.equal(preview.grid.length,90);assert(preview.groundWidth>0);
  const settings={bounds,sourceId:'sample',width:60,spacing:2,base:3,relief:2,across:2,down:1,minElevation:preview.min};
  const j=await post('/generate',settings);
  let job;
  for(let i=0;i<100;i++){
    await delay(100);job=await (await fetch(base+'/jobs/'+j.id)).json();if(job.status!=='running')break;
  }
  assert.equal(job.status,'done',job.message);assert.equal(job.files.length,3);
  const sidecar=await (await fetch(base+'/jobs/'+j.id+'/files/settings-credits.json')).json();
  assert.equal(sidecar.units,'millimetres');assert(sidecar.outputGridSpacingMetres);
  const binary=await (await fetch(base+'/jobs/'+j.id+'/files/terrain-1-1.stl')).arrayBuffer();
  const triangles=new DataView(binary).getUint32(80,true);
  assert.equal(binary.byteLength,84+50*triangles);
  const cancel=await post('/generate',{...settings,width:500,spacing:1});
  await post('/jobs/'+cancel.id+'/cancel',{});
  const cancelled=await (await fetch(base+'/jobs/'+cancel.id)).json();
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.files.length,0);
  const forbidden=await fetch(base+'/sources',{headers:{Origin:'https://example.com'}});
  assert.equal(forbidden.status,403);
  console.log('API smoke passed: source list, metric preview, tiled generation, credits, binary STL, cancellation, local-origin restriction.');
  if(process.argv.includes('--online')){
    const r=await fetch(base+'/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:'mapterhorn',bounds:[7.9,46.6,7.91,46.61],width:100,spacing:1})});
    assert.match(r.headers.get('content-type'),/ndjson/);
    const events=(await r.text()).trim().split('\n').map(line=>JSON.parse(line));
    const result=events.find(v=>v.result),error=events.find(v=>v.error);
    assert(result||error,'Expected final elevation result or explicit fetch failure');
    console.log(result?'Live Mapterhorn preview succeeded.':'Live Mapterhorn failure reported clearly: '+error.error);
    if(result){
      const model=await post('/generate',{...settings,sourceId:'mapterhorn',bounds:[7.9,46.6,7.91,46.61],width:40,spacing:2,across:1,down:1,minElevation:result.result.min});
      let status;
      for(let i=0;i<1800;i++){await delay(100);status=await (await fetch(base+'/jobs/'+model.id)).json();if(status.status!=='running')break}
      assert.equal(status.status,'done',status.message);
      const credit=await (await fetch(base+'/jobs/'+model.id+'/files/settings-credits.json')).json();
      assert.equal(credit.sourceMetadata.provider,'Mapterhorn');
      assert(credit.sourceMetadata.tilejson.tiles.length);
      assert.equal(credit.sourceMetadata.nativeResolutionMetres,null);
      assert(credit.sourceMetadata.sourceCatalogue.length);
      console.log('Live Mapterhorn STL export passed with published TileJSON, source catalogue and unresolved licence fields in the sidecar.');
    }

  }
  process.exit(0);
}catch(e){console.error(e);process.exit(1)}
