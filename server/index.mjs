import express from 'express';
import {registerLaserRoutes} from './laser.mjs';
import multer from 'multer';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const root=path.resolve('data');
await mkdir(root+'/imports',{recursive:true});await mkdir(root+'/jobs',{recursive:true});
const python=process.env.MAPSCONTOUR_PYTHON || (existsSync('.venv/bin/python')?'.venv/bin/python':'python3');
const port=process.env.NODE_ENV==='test'?Number(process.env.MAPSCONTOUR_TEST_PORT||4312):4311;
const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{
  if(![`127.0.0.1:${port}`,'127.0.0.1:4311','127.0.0.1:5173','localhost:5173'].includes(req.headers.host))return res.status(403).json({error:'Invalid local host'});
  if(req.headers.origin&&!['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:4311'].includes(req.headers.origin))return res.status(403).json({error:'Local access only'});
  next();
});
registerLaserRoutes(app,root);
app.use(express.json({limit:'100kb'}));
const upload=multer({dest:root+'/imports',limits:{fileSize:2*1024**3,files:1}});
const sample={id:'sample',name:'Workshop mountain · synthetic',bounds:[-122,46.78,-121.65,47.02],resolution:90,limitations:'Generated demonstration terrain, not a real survey. Nominal 90 m sampling. No external elevation provider.',attribution:'MapsContour synthetic terrain · freely reusable'};
const mapterhorn={id:'mapterhorn',provider:'mapterhorn',name:'Mapterhorn · online elevation',bounds:[-180,-80,180,80],resolution:null,
  limitations:'Published coverage is checked when fetching. Underlying source, native resolution, vertical datum and licence for this area are unknown until verified; tile sampling is not native resolution.',
  attribution:'Mapterhorn — https://mapterhorn.com/attribution/',attributionUrl:'https://mapterhorn.com/attribution/'};
const sources=new Map([['sample',sample],['mapterhorn',mapterhorn]]),jobs=new Map(),activeWorkers=new Set();let running=false;
try{for(const s of JSON.parse(await readFile(root+'/sources.json','utf8')))if(!['sample','mapterhorn'].includes(s.id))sources.set(s.id,s)}catch{}
function worker(payload,onUpdate){
  const child=spawn(python,['worker/main.py'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});activeWorkers.add(child);
  let buffer='',err='',result;
  const promise=new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{
      buffer+=chunk;let i;
      while((i=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        try{const v=JSON.parse(line);if(v.error)err=v.error;if(v.result)result=v.result;onUpdate?.(v)}catch{}
      }
    });
    child.stderr.on('data',d=>{err=(err+d.toString()).slice(-4000)});
    child.on('error',()=>{activeWorkers.delete(child);reject(new Error('Python worker could not start. Install requirements into .venv (see README).'))});
    child.on('close',code=>{activeWorkers.delete(child);code===0&&result?resolve(result):reject(new Error(err||'Worker stopped. Check Python dependencies.'))});
  });
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));return {child,promise};
}
function validate(req){
  const b=req.bounds;
  if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]>=b[2]||b[1]>=b[3]||b[0]<-180||b[2]>180||b[1]<-80||b[3]>80)throw Error('Enter valid west, south, east, north coordinates between 80°S and 80°N, without crossing the date line.');
  const s=sources.get(req.sourceId);if(!s)throw Error('Choose an elevation source.');return s;
}
app.get('/api/sources',(_,res)=>res.json([...sources.values()].map(({path,...s})=>s)));
app.post('/api/import',upload.single('dem'),async(req,res,next)=>{
  try{
    if(!req.file)throw Error('Choose a GeoTIFF.');
    const result=await worker({action:'metadata',path:req.file.path}).promise;
    const s={...result,id:randomUUID(),name:req.file.originalname,path:req.file.path,attribution:String(req.body.attribution||'Attribution not supplied. Verify source licence before sharing.')};
    sources.set(s.id,s);await writeFile(root+'/sources.json',JSON.stringify([...sources.values()].filter(s=>!['sample','mapterhorn'].includes(s.id))));
    res.json({...s,path:undefined});
  }catch(e){if(req.file)await unlink(req.file.path).catch(()=>{});next(e)}
});
app.post('/api/preview',async(req,res,next)=>{
  let w;
  try{
    const s=validate(req.body);
    const payload={action:'preview',provider:s.provider,path:s.path,bounds:req.body.bounds,nx:90,ny:90};
    if(s.provider==='mapterhorn'){
      for(const [key,min,max] of [['width',1,2000],['spacing',.2,10]]){
        const v=req.body[key];if(!Number.isFinite(v)||v<min||v>max)throw Error('Invalid '+key);payload[key]=v;
      }
      res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');res.flushHeaders();
      w=worker(payload,v=>{if(!res.destroyed)res.write(JSON.stringify(v)+'\n')});
      res.on('close',()=>{if(!res.writableEnded)w.child.kill('SIGTERM')});
      await w.promise;if(!res.destroyed)res.end();
    }else{
      w=worker(payload);res.on('close',()=>{if(!res.writableEnded)w.child.kill('SIGTERM')});
      const result=await w.promise;if(!res.destroyed)res.json(result);
    }
  }catch(e){
    if(res.headersSent){if(!res.destroyed)res.end(JSON.stringify({error:e.message})+'\n')}
    else next(e);
  }
});
app.post('/api/generate',async(req,res,next)=>{
  let reserved=false;
  try{
    if(running)throw Error('A model is already generating. Wait or cancel it first.');
    const s=validate(req.body),p=req.body;
    for(const [k,min,max] of [['width',1,2000],['base',0.2,100],['relief',0.1,20],['spacing',0.2,10],['across',1,12],['down',1,12],['minElevation',-15000,15000]])if(!Number.isFinite(p[k])||p[k]<min||p[k]>max)throw Error('Invalid '+k);
    if(!Number.isInteger(p.across)||!Number.isInteger(p.down))throw Error('Tile counts must be integers.');
    running=true;reserved=true;
    const dims=await worker({action:'dimensions',bounds:p.bounds}).promise;
    const length=p.width*dims.groundLength/dims.groundWidth;
    const nx=Math.ceil(Math.max(p.across,p.width/p.spacing)/p.across)*p.across+1;
    const ny=Math.ceil(Math.max(p.down,length/p.spacing)/p.down)*p.down+1;
    if(nx*ny>1500000)throw Error('Output exceeds 1.5 million grid nodes. Increase grid spacing or reduce the model size.');
    const id=randomUUID(),output=root+'/jobs/'+id;await mkdir(output);
    const payload={...p,action:'generate',provider:s.provider,path:s.path,source:s.name,attribution:s.attribution,output,nx,ny};
    const job={id,status:'running',progress:0,message:'Reading elevation…',files:[]};jobs.set(id,job);
    const w=worker(payload,v=>{if(job.status==='running'){if(v.progress!==undefined)job.progress=v.progress;if(v.message)job.message=v.message}});job.child=w.child;
    w.promise.then(result=>{if(job.status==='running')Object.assign(job,{status:'done',progress:100,files:result.files,message:'All tiles checked and saved locally.'})})
      .catch(e=>{if(job.status==='running')Object.assign(job,{status:'error',message:e.message})}).finally(()=>{running=false});
    res.json({id});
  }catch(e){if(reserved)running=false;next(e)}
});
app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.sendStatus(404);const {child,...safe}=j;res.json(safe)});
app.post('/api/jobs/:id/cancel',(req,res)=>{const j=jobs.get(req.params.id);if(j?.status==='running'){j.status='cancelled';j.message='Cancelled. Partial files are not offered for download.';j.child.kill('SIGTERM')}res.json({ok:true})});
app.get('/api/jobs/:id/files/:file',(req,res)=>{const j=jobs.get(req.params.id);if(j?.status!=='done'||!j.files.includes(req.params.file))return res.sendStatus(404);res.download(path.join(root,'jobs',j.id,req.params.file))});
app.use((err,req,res,next)=>res.status(400).json({error:err.message}));
app.listen(port,'127.0.0.1',error=>{if(error)throw error;console.log(`Local API: http://127.0.0.1:${port}`)});
process.on('exit',()=>{for(const child of activeWorkers)child.kill('SIGTERM')});
