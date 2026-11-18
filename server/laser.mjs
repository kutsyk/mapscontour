import express from 'express';
import {registerLaserJobs} from './laser-jobs.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {buildLaserQuery} from '../shared/laser-query.mjs';
export const OVERPASS='https://overpass-api.de/api/interpreter';
const MAX_BYTES=32*1024*1024;
export function validateOverpass(data){
  if(data.remark)throw Error('Overpass reported an incomplete result: '+String(data.remark).slice(0,300));
  if(!Array.isArray(data.elements))throw Error('Overpass did not return a feature collection.');
  if(data.elements.length>50000)throw Error('More than 50,000 features: select a smaller area or fewer layers.');
  let nodes=0;
  for(const e of data.elements){nodes+=e.geometry?.length||0;for(const m of e.members||[])nodes+=m.geometry?.length||0}
  if(nodes>500000)throw Error('More than 500,000 geometry points: select a smaller area or fewer layers.');
  return data;
}
export function registerLaserRoutes(app,root){
  const router=express.Router(),cache=path.join(root,'cache','laser'),outputs=path.join(root,'laser');let active=false;
  router.use(express.json({limit:'20mb'}));
  registerLaserJobs(router,root);
  router.post('/features',async(req,res)=>{
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort()});
    let ownsSlot=false;
    const emit=v=>{if(!res.destroyed)res.write(JSON.stringify(v)+'\n')};
    try{
      const query=buildLaserQuery(req.body.bounds,req.body.layers),key=createHash('sha256').update(query).digest('hex');
      if(active)return res.status(409).json({error:'An OSM request is already running. Cancel it or wait before fetching again.'});
      active=true;ownsSlot=true;
      res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');res.flushHeaders();
      const file=path.join(cache,key+'.json');let payload;
      try{if(Date.now()-(await stat(file)).mtimeMs<86400000)payload=validateOverpass(JSON.parse(await readFile(file,'utf8')))}catch{}
      let cached=!!payload;
      if(!payload){
        for(let attempt=0;attempt<3;attempt++){
          if(controller.signal.aborted)throw Error('Cancelled');
          const timeout=AbortSignal.timeout(110000),signal=AbortSignal.any([controller.signal,timeout]);
          try{
            emit({progress:5,message:`Requesting OSM features (${attempt+1}/3)…`});
            const response=await fetch(OVERPASS,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'MapsContour-local-workshop/0.1'},body:new URLSearchParams({data:query}),signal});
            if(!response.ok){
              await response.body?.cancel();
              const err=Error(`Overpass HTTP ${response.status}`);err.retry=response.status===429||response.status>=500;throw err;
            }
            const reader=response.body.getReader(),chunks=[];let bytes=0;
            while(true){
              const {done,value}=await reader.read();if(done)break;bytes+=value.length;
              if(bytes>MAX_BYTES){await reader.cancel();throw Error('OSM response exceeds 32 MiB. Select a smaller area.')}
              chunks.push(value);emit({progress:Math.min(55,10+bytes/MAX_BYTES*45),message:`Receiving OSM data: ${(bytes/1e6).toFixed(1)} MB`});
            }
            payload=validateOverpass(JSON.parse(Buffer.concat(chunks).toString('utf8')));break;
          }catch(error){
            if(controller.signal.aborted)throw Error('Cancelled');
            if(attempt===2||error.retry===false||(!error.retry&&!(error instanceof TypeError)&&error.name!=='TimeoutError'))throw error;
            emit({progress:5,message:'Overpass is busy; waiting before retry…'});
            await delay((attempt+1)*3000,undefined,{signal:controller.signal});
          }
        }
        payload={...payload,fetchedAt:new Date().toISOString()};
        await mkdir(cache,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
        await writeFile(temp,JSON.stringify(payload));await rename(temp,file);
      }
      const credits={source:'OpenStreetMap contributors',attribution:'© OpenStreetMap contributors',license:'ODbL 1.0',licenseUrl:'https://www.openstreetmap.org/copyright',endpoint:OVERPASS,fetchedAt:payload.fetchedAt,dataTimestamp:payload.osm3s?.timestamp_osm_base||null,cached};
      emit({progress:60,message:`${payload.elements.length.toLocaleString()} OSM features ready${cached?' from local cache':''}`,result:{elements:payload.elements,credits}});res.end();
    }catch(error){if(!res.destroyed){if(!res.headersSent)res.status(400).json({error:error.message});else{emit({error:error.message});res.end()}}}
    finally{if(ownsSlot)active=false}
  });
  router.post('/save',async(req,res,next)=>{
    try{
      const {svg,credits}=req.body;
      if(typeof svg!=='string'||svg.length>16*1024*1024||!svg.startsWith('<svg ')||!svg.includes('xmlns="http://www.w3.org/2000/svg"'))throw Error('Invalid or oversized SVG export.');
      if(!credits||typeof credits!=='object')throw Error('Missing map settings and credits.');
      const id=randomUUID(),dir=path.join(outputs,id);await mkdir(dir,{recursive:true});
      await writeFile(path.join(dir,'map.svg'),svg);await writeFile(path.join(dir,'settings-credits.json'),JSON.stringify(credits,null,2));
      res.json({id,files:['map.svg','settings-credits.json']});
    }catch(e){next(e)}
  });
  router.get('/exports/:id/files/:file',(req,res)=>{
    if(!/^[0-9a-f-]{36}$/.test(req.params.id)||!['map.svg','preview.svg','settings-credits.json',...['majorRoads','minorRoads','buildings','water','waterLines','parks','airports','railways'].map(l=>'layer-'+l+'.svg')].includes(req.params.file))return res.sendStatus(404);
    res.download(path.join(outputs,req.params.id,req.params.file));
  });
  app.use('/api/laser',router);
}
