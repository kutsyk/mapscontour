import {buildPreviewGeometry} from './previewGeometry';
self.onmessage=(event:MessageEvent<{id:number;grid:number[][];min:number;max:number}>)=>{
  const {id,grid,min,max}=event.data;
  try{
    const buffers=buildPreviewGeometry(grid,min,max);
    self.postMessage({id,buffers},{transfer:[buffers.positions.buffer,buffers.normals.buffer,buffers.indices.buffer,buffers.sidePositions.buffer,buffers.sideNormals.buffer]});
  }catch(error){self.postMessage({id,error:error instanceof Error?error.message:String(error)})}
};
