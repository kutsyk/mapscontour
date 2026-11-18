import multer from 'multer';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream,existsSync} from 'node:fs';
import {mkdir,readFile,readdir,rename,unlink,stat,statfs} from 'node:fs/promises';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {buildLaserQuery} from '../shared/laser-query.mjs';
const PUBLIC_OVERPASS='https://overpass-api.de/api/interpreter';
const uuid=/^[a-f0-9-]{36}$/;
export function registerLaserJobs(router,root){
  const sources=path.join(root,'laser-sources'),cache=path.join(root,'cache','laser'),outputs=path.join(root,'laser');
  const jobs=new Map();let active=null;
  const python=process.env.MAPSCONTOUR_PYTHON||(existsSync('.venv/bin/python')?'.venv/bin/python':'python3');
  const endpoint=process.env.MAPSCONTOUR_OVERPASS_URL||PUBLIC_OVERPASS;
  if(!['http:','https:'].includes(new URL(endpoint).protocol))throw Error('MAPSCONTOUR_OVERPASS_URL must use http or https');
  const upload=multer({dest:path.join(root,'laser-uploads')});
  function start(kind,run){
    if(active)throw Error('A map job is already running. Wait or cancel it first.');
    const id=randomUUID(),controller=new AbortController();
    const job={id,kind,status:'running',progress:0,message:'Preparing local map job…',controller};jobs.set(id,job);active=id;
    Promise.resolve().then(()=>run(job)).then(result=>{
      if(job.status==='running')Object.assign(job,{status:'done',progress:100,message:kind==='import'?'Local map source indexed.':'Full-resolution SVG files saved locally.',result});
    }).catch(e=>{if(job.status==='running')Object.assign(job,{status:'error',message:e.message})}).finally(()=>{active=null});
    return job;
  }
  function worker(job,payload){
    return new Promise((resolve,reject)=>{
      const child=spawn(python,['worker/laser_large.py'],{stdio:['pipe','pipe','pipe']});job.child=child;
      const abort=()=>child.kill('SIGTERM');job.controller.signal.addEventListener('abort',abort,{once:true});if(job.controller.signal.aborted)abort();
      let buffer='',error='',result;
      child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const v=JSON.parse(line);if(v.error)error=v.error;if(v.result)result=v.result;if(v.message)job.message=v.message;if(v.progress!==undefined)job.progress=Math.max(job.progress,Math.min(98,30+v.progress*.68))}catch{}}});
      child.stderr.on('data',d=>error=(error+d.toString()).slice(-5000));
      child.on('error',reject);child.on('close',code=>{job.controller.signal.removeEventListener('abort',abort);job.child=null;if(code===0&&result)resolve(result);else reject(Error(error.includes('ModuleNotFoundError')?'Install the updated Python dependencies: .venv/bin/pip install -r requirements.txt':error||'Map worker stopped.'))});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
    });
  }
  async function download(job,query){
    await mkdir(cache,{recursive:true});const key=createHash('sha256').update(endpoint+'\n'+query).digest('hex'),file=path.join(cache,key+'.json'),database=path.join(cache,key+'.sqlite');
    try{if(Date.now()-(await stat(file)).mtimeMs<86400000)return {file,database,cached:true}}
    catch{}
    // Expired raw data must not reuse an index built from an older response.
    await unlink(database).catch(()=>{});
    const signal=job.controller.signal;
    for(let attempt=0;attempt<3;attempt++){
      const partial=file+'.partial';
      try{
        signal.throwIfAborted();job.message=`Requesting OSM data (${attempt+1}/3)…`;
        const deadline=AbortSignal.any([signal,AbortSignal.timeout(180000)]);
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'MapsContour-local-workshop/0.2'},body:new URLSearchParams({data:query}),signal:deadline});
        if(!response.ok){await response.body?.cancel();const e=Error('Overpass HTTP '+response.status+'. Use a local OSM extract for large regions.');e.retry=response.status===429||response.status>=500;e.retryAfter=Number(response.headers.get('retry-after'))||3*(attempt+1);throw e}
        const length=Number(response.headers.get('content-length'))||0;let bytes=0,last=0,checked=0;
        const progress=new Transform({transform(chunk,_,done){
          bytes+=chunk.length;
          const report=()=>{if(Date.now()-last>400){job.message=`Receiving OSM data to disk: ${(bytes/1e6).toFixed(1)} MB`;job.progress=length?Math.min(29,bytes/length*29):Math.min(29,5+Math.log2(1+bytes/1e6)*3);last=Date.now()}done(null,chunk)};
          if(bytes-checked>64*1024*1024){checked=bytes;statfs(cache).then(s=>{if(s.bavail*s.bsize<256*1024*1024)done(Error('Not enough free disk space for the map. Free disk space and retry.'));else report()}).catch(done)}else report();
        }});
        await pipeline(response.body,progress,createWriteStream(partial),{signal:deadline});
        await rename(partial,file);return {file,database,cached:false};
      }catch(e){
        await unlink(partial).catch(()=>{});if(signal.aborted)throw e;
        if(attempt===2||(!e.retry&&e.name!=='TimeoutError'&&!(e instanceof TypeError)))throw e;
        const wait=Math.max(3,Math.min(120,e.retryAfter||3*(attempt+1)));job.message=`OSM service busy; retrying in ${wait}s. Local extracts avoid public service limits.`;
        await delay(wait*1000,undefined,{signal});
      }
    }
  }
  router.get('/sources',async(_,res,next)=>{
    try{await mkdir(sources,{recursive:true});const list=[];for(const file of await readdir(sources)){if(!file.endsWith('.json'))continue;try{const v=JSON.parse(await readFile(path.join(sources,file),'utf8'));list.push(v)}catch{}}res.json({sources:list,endpoint,publicEndpoint:endpoint===PUBLIC_OVERPASS})}catch(e){next(e)}
  });
  router.post('/imports',upload.single('map'),async(req,res,next)=>{
    try{
      if(!req.file)throw Error('Choose an OSM PBF, Overpass JSON, or OSM GeoJSON file.');
      const id=randomUUID(),name=req.file.originalname;
      if(!/\.(json|geojson|pbf|osm)$/i.test(name))throw Error('Supported imports: .osm.pbf, .osm, .json and .geojson.');
      await mkdir(sources,{recursive:true});
      const filename=path.join(sources,id+(/\.(pbf|osm)$/i.test(name)?path.extname(name):'.json.input'));
      await rename(req.file.path,filename);
      const job=start('import',async job=>{
        const source={id,name,source:'OpenStreetMap local extract: '+name,attribution:String(req.body.attribution||'© OpenStreetMap contributors'),license:'ODbL 1.0 — verify extract-specific notices',licenseUrl:'https://www.openstreetmap.org/copyright',importedAt:new Date().toISOString()};
        return worker(job,{action:'import',path:filename,database:path.join(sources,id+'.sqlite'),metadata:path.join(sources,id+'.json'),source});
      });res.json({id:job.id});
    }catch(e){if(req.file)await unlink(req.file.path).catch(()=>{});next(e)}
  });
  router.post('/jobs',async(req,res,next)=>{
    try{
      const {bounds,settings,sourceId='overpass'}=req.body;
      if(!settings||!Array.isArray(settings.layers))throw Error('Missing map settings.');
      let query,source;
      if(sourceId==='overpass')query=buildLaserQuery(bounds,settings.layers.filter(l=>l.enabled).map(l=>l.id),{large:endpoint!==PUBLIC_OVERPASS});
      else{
        if(!uuid.test(sourceId))throw Error('Choose a valid local map source.');
        source=JSON.parse(await readFile(path.join(sources,sourceId+'.json'),'utf8'));
      }
      const job=start('export',async job=>{
        const id=job.id,output=path.join(outputs,id);await mkdir(output,{recursive:true});
        let raw,database,credits;
        if(sourceId==='overpass'){
          const downloaded=await download(job,query);raw=downloaded.file;database=downloaded.database;
          credits={source:'OpenStreetMap contributors',attribution:'© OpenStreetMap contributors',license:'ODbL 1.0',licenseUrl:'https://www.openstreetmap.org/copyright',endpoint,fetchedAt:(await stat(raw)).mtime.toISOString(),cached:downloaded.cached};
        }else{database=path.join(sources,sourceId+'.sqlite');credits=source}
        job.controller.signal.throwIfAborted();
        let result;
        try{result=await worker(job,{action:'export',path:raw,database,output,bounds,settings,source:credits})}
        catch(e){if(sourceId==='overpass'&&!existsSync(database)&&!job.controller.signal.aborted)await unlink(raw).catch(()=>{});throw e}
        return {...result,id};
      });res.json({id:job.id});
    }catch(e){next(e)}
  });
  router.get('/jobs/:id',(req,res)=>{
    const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:'Map job not found'});
    const {child,controller,...safe}=job;res.json(safe);
  });
  router.post('/jobs/:id/cancel',(req,res)=>{
    const job=jobs.get(req.params.id);if(job?.status==='running'){job.status='cancelled';job.message='Map job cancelled. Completed source/cache files are retained.';job.controller.abort();job.child?.kill('SIGTERM')}
    res.json({ok:true});
  });
  router.get('/preview/:id',async(req,res,next)=>{
    try{if(!uuid.test(req.params.id))return res.sendStatus(404);await stat(path.join(outputs,req.params.id,'manifest.json'));res.type('image/svg+xml').sendFile(path.join(outputs,req.params.id,'preview.svg'))}catch(e){next(e)}
  });
  process.on('exit',()=>{for(const job of jobs.values())if(job.status==='running'){job.controller.abort();job.child?.kill('SIGTERM')}});
}
