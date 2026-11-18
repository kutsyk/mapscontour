import {buildLaserSVG} from './geometry';
self.onmessage=event=>{
  try{const result=buildLaserSVG({...event.data,onProgress:(progress,message)=>self.postMessage({progress,message})});self.postMessage({result})}
  catch(e){self.postMessage({error:e instanceof Error?e.message:String(e)})}
};
