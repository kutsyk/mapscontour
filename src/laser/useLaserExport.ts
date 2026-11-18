import {useEffect,useRef,useState} from 'react';
import {defaultSettings,type Bounds,type Element,type LaserSettings,laserLayout} from './geometry';
type Source={id:string;name:string;featureCount:number;bounds:Bounds;counts:Record<string,number>};
type Result={svg:string;credits:Record<string,unknown>;width:number;height:number;pathCount:number;counts:Record<string,number>;warnings:string[];id:string;signature:string;files?:string[];bytes?:number;previewUrl?:string;previewSimplified?:boolean};
type Task={controller:AbortController;worker?:Worker;reject?:()=>void;jobId?:string};
function initial():LaserSettings{
  try{const value=JSON.parse(localStorage.getItem('mapscontour-laser-settings')||'null');if(value&&Array.isArray(value.layers))return {...defaultSettings,...value,layers:defaultSettings.layers.map(layer=>({...layer,...value.layers.find((l:{id:string})=>l.id===layer.id)}))}}catch{}
  return structuredClone(defaultSettings);
}
function sampleFeatures([w,s,e,n]:Bounds):Element[]{
  const p=(u:number,v:number)=>({lon:w+(e-w)*u,lat:s+(n-s)*v});
  return [
    {type:'way',id:1,tags:{highway:'primary'},geometry:[p(-.1,.2),p(.3,.5),p(.7,.6),p(1.1,.8)]},
    {type:'way',id:2,tags:{highway:'residential'},geometry:[p(.1,.9),p(.5,.5),p(.9,.1)]},
    {type:'way',id:3,tags:{building:'yes'},geometry:[p(.2,.65),p(.4,.65),p(.4,.85),p(.2,.85),p(.2,.65)]},
    {type:'way',id:4,tags:{natural:'water'},geometry:[p(.6,.15),p(.8,.15),p(.85,.4),p(.65,.45),p(.6,.15)]}
  ];
}
async function jsonRequest(url:string,body:unknown,signal?:AbortSignal){
  const response=await fetch('/api/laser'+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Local map request failed');return result;
}
function pause(signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'))};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},500);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
})}
export function useLaserExport(bounds:Bounds,enabled:boolean){
  const [settings,setSettings]=useState<LaserSettings>(initial),[result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[message,setMessage]=useState(''),[error,setError]=useState(''),[url,setUrl]=useState('');
  const [sources,setSources]=useState<Source[]>([]),[publicEndpoint,setPublicEndpoint]=useState(true);
  const operation=useRef<Task|null>(null);
  const signature=JSON.stringify({bounds,settings}),current=result?.signature===signature;
  async function refreshSources(){const r=await fetch('/api/laser/sources');if(r.ok){const v=await r.json();setSources(v.sources);setPublicEndpoint(v.publicEndpoint)}}
  useEffect(()=>{refreshSources().catch(()=>{})},[]);
  useEffect(()=>{localStorage.setItem('mapscontour-laser-settings',JSON.stringify(settings))},[settings]);
  useEffect(()=>{
    if(!result)return;
    if(result.previewUrl){setUrl(result.previewUrl);return}
    const next=URL.createObjectURL(new Blob([result.svg],{type:'image/svg+xml'}));setUrl(next);return()=>URL.revokeObjectURL(next);
  },[result]);
  const cancel=()=>{
    const task=operation.current;if(task?.jobId)jsonRequest('/jobs/'+task.jobId+'/cancel',{}).catch(()=>{});
    task?.controller.abort();task?.worker?.terminate();task?.reject?.();
  };
  useEffect(()=>{if(!enabled)cancel()},[enabled]);
  useEffect(()=>()=>cancel(),[]);
  async function poll(task:Task,id:string){
    task.jobId=id;
    if(task.controller.signal.aborted){await jsonRequest('/jobs/'+id+'/cancel',{});throw new DOMException('Cancelled','AbortError')}
    while(true){
      const response=await fetch('/api/laser/jobs/'+id,{signal:task.controller.signal}),job=await response.json();
      if(!response.ok)throw Error(job.error||'Map job not found');setProgress(job.progress);setMessage(job.message);
      if(job.status==='done')return job.result;
      if(job.status==='error'){setMessage('Map job stopped.');throw Error(job.message)}
      if(job.status==='cancelled')throw new DOMException('Cancelled','AbortError');
      await pause(task.controller.signal);
    }
  }
  const importMap=async(file:File)=>{
    if(operation.current)return;const task:Task={controller:new AbortController()};operation.current=task;
    setBusy(true);setError('');setProgress(0);setMessage(`Uploading ${file.name} to local disk…`);
    try{
      const form=new FormData();form.append('map',file);
      const r=await fetch('/api/laser/imports',{method:'POST',body:form,signal:task.controller.signal}),job=await r.json();
      if(!r.ok)throw Error(job.error||'Import failed');
      const source=await poll(task,job.id);await refreshSources();setSettings(v=>({...v,sourceId:source.id}));
      setMessage(`Indexed ${source.featureCount.toLocaleString()} map features. Generate from this local source without downloading again.`);
    }catch(e){if(task.controller.signal.aborted||(e instanceof Error&&e.name==='AbortError'))setMessage('Map import cancelled.');else setError(e instanceof Error?e.message:String(e))}
    finally{operation.current=null;setBusy(false)}
  };
  const generate=async(demo=false)=>{
    if(operation.current)return;
    setError('');setBusy(true);setProgress(0);setMessage('Preparing map export…');
    const task:Task={controller:new AbortController()};operation.current=task;
    const signal=task.controller.signal;
    try{
      laserLayout(bounds,settings.width,settings.margin);
      if(!settings.layers.some(l=>l.enabled))throw Error('Choose at least one map layer.');
      if(!demo){
        // Only settings go to the API. Raw OSM, indexing and full SVG remain on local disk.
        const job=await jsonRequest('/jobs',{bounds,settings,sourceId:settings.sourceId||'overpass'});
        const built=await poll(task,job.id);
        setResult({...built,svg:'',signature,previewUrl:'/api/laser/preview/'+built.id});
        setMessage(`Saved ${built.pathCount.toLocaleString()} full-detail paths. The bounded preview does not reduce export detail.`);
      }else{
        const credits={source:'Synthetic demonstration map — not real OSM data',attribution:'MapsContour synthetic demo',license:'Freely reusable generated example',fetchedAt:new Date().toISOString()};
        const built=await new Promise<Omit<Result,'id'|'signature'>>((resolve,reject)=>{
          task.reject=()=>reject(new DOMException('Cancelled','AbortError'));
          task.worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
          task.worker.onmessage=e=>{const v=e.data;if(v.error)reject(Error(v.error));else if(v.result)resolve(v.result);else{setProgress(v.progress);setMessage(v.message)}};
          task.worker.onerror=()=>reject(Error('SVG demonstration could not be generated.'));
          task.worker.postMessage({bounds,settings,elements:sampleFeatures(bounds),credits});
        });
        signal.throwIfAborted();const files=await jsonRequest('/save',{svg:built.svg,credits:built.credits},signal);setResult({...built,id:files.id,signature});
      }
      setProgress(100);
    }catch(e){if(signal.aborted||(e instanceof Error&&e.name==='AbortError'))setMessage('Map export cancelled.');else setError(e instanceof Error?e.message:String(e))}
    finally{task.worker?.terminate();operation.current=null;setBusy(false)}
  };
  return {settings,setSettings,result,current,busy,progress,message,error,url,generate,cancel,sources,importMap,publicEndpoint};
}
export type LaserController=ReturnType<typeof useLaserExport>;
