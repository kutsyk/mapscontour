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
  const {readFileSync}=await import('node:fs');
  const ts=await import('typescript');
  const src=readFileSync(new URL('../src/laser/geometry.ts',import.meta.url),'utf8');
  const {outputText}=ts.default.transpileModule(src,{compilerOptions:{module:ts.default.ModuleKind.ESNext,target:ts.default.ScriptTarget.ES2022}});
  const moduleText=outputText.replaceAll('"polygon-clipping"',JSON.stringify(import.meta.resolve('polygon-clipping'))).replaceAll("'polygon-clipping'",JSON.stringify(import.meta.resolve('polygon-clipping')));
  const {buildLaserSVG,defaultSettings}=await import('data:text/javascript;base64,'+Buffer.from(moduleText).toString('base64'));
  const vector=buildLaserSVG({bounds:[0,0,.01,.01],settings:defaultSettings,elements:[{type:'way',id:1,tags:{highway:'primary'},geometry:[{lon:-.001,lat:.005},{lon:.011,lat:.005}]}],credits:{source:'API test fixture',license:'test'}});
  const laser=await post('/laser/save',{svg:vector.svg,credits:vector.credits});
  assert.equal(laser.files.length,2);
  const svgResponse=await fetch(base+'/laser/exports/'+laser.id+'/files/map.svg');
  assert.match(svgResponse.headers.get('content-disposition'),/attachment/);
  assert.equal(await svgResponse.text(),vector.svg);
  const laserCredits=await (await fetch(base+'/laser/exports/'+laser.id+'/files/settings-credits.json')).json();
  assert.equal(laserCredits.feature,'laser-map');assert.equal(laserCredits.widthMm,250);
  const invalid=await fetch(base+'/laser/features',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bounds:[0,0,10,10],layers:['buildings']})});
  assert.equal(invalid.status,400);
  console.log('Laser smoke passed: SVG/credits persistence, attachment download, physical dimensions and query limits.');

  const form=new FormData();
  form.append('map',new Blob([JSON.stringify({elements:[{type:'way',id:123,tags:{highway:'primary'},geometry:[{lon:.001,lat:.001},{lon:.009,lat:.009}]}]})],{type:'application/json'}),'local-fixture.json');
  const upload=await (await fetch(base+'/laser/imports',{method:'POST',body:form})).json();
  const waitMap=async id=>{for(let i=0;i<200;i++){await delay(100);const j=await (await fetch(base+'/laser/jobs/'+id)).json();if(j.status==='error')throw Error(j.message);if(j.status==='done')return j.result}throw Error('Map test timed out')};
  const local=await waitMap(upload.id);
  assert.equal(local.featureCount,1);
  const sourcesResult=await (await fetch(base+'/laser/sources')).json();assert(sourcesResult.sources.some(s=>s.id===local.id));
  const mapJob=await post('/laser/jobs',{bounds:[0,0,.01,.01],settings:defaultSettings,sourceId:local.id});
  const diskMap=await waitMap(mapJob.id);
  assert.equal(diskMap.pathCount,1);assert.equal(diskMap.credits.exportSimplified,false);
  assert(diskMap.files.includes('layer-majorRoads.svg'));
  const localPreview=await fetch(base+'/laser/preview/'+diskMap.id);assert.match(localPreview.headers.get('content-type'),/svg/);
  const layerDownload=await fetch(base+'/laser/exports/'+diskMap.id+'/files/layer-majorRoads.svg');assert.equal(layerDownload.status,200);
  assert.match(await layerDownload.text(),/width="250mm"/);
  console.log('Large-map API passed: streamed import, disk index, source catalogue, background export, bounded preview and individual layer download.');
  if(process.argv.includes('--laser-online')){
    try{
      const r=await fetch(base+'/laser/features',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bounds:[2.294,48.8575,2.296,48.859],layers:['buildings','parks']}),signal:AbortSignal.timeout(40000)});
      assert(r.ok,'Laser HTTP '+r.status);
      const events=(await r.text()).trim().split('\n').map(line=>JSON.parse(line));
      const result=events.find(v=>v.result),error=events.find(v=>v.error);
      if(error)console.log('Live Overpass request reported: '+error.error);
      else{assert(result);assert(Array.isArray(result.result.elements));console.log('Live Overpass request passed: '+result.result.elements.length+' elements; '+result.result.credits.attribution)}
    }catch(e){console.log('Live Overpass unavailable in this environment: '+e.message)}
  }
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
