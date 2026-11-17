/** Preview-only geometry. These buffers are never sent to the STL worker. */
export const MAX_PREVIEW_TRIANGLES = 200_000;
export type PreviewBuffers = {
  positions:Float32Array; normals:Float32Array; indices:Uint32Array;
  sidePositions:Float32Array; sideNormals:Float32Array;
  columns:number; rows:number; triangles:number;
};

export function previewDimensions(columns:number,rows:number,maxTriangles=MAX_PREVIEW_TRIANGLES) {
  if(columns<2||rows<2||maxTriangles<2)throw Error('Preview needs at least a 2 × 2 grid.');
  const cells=Math.floor(maxTriangles/2),x=columns-1,y=rows-1;
  if(x*y<=cells)return {columns,rows};
  const ratio=Math.sqrt(x*y/cells);
  let sx=Math.max(1,Math.floor(x/ratio)),sy=Math.max(1,Math.floor(y/ratio));
  if(sx*sy>cells){if(sx>=sy)sx=Math.floor(cells/sy);else sy=Math.floor(cells/sx)}
  return {columns:sx+1,rows:sy+1};
}

/** Area averaging suppresses aliasing; asymmetric extrema retain isolated peaks/valleys.
 * Boundary vertices sample the original boundary so interior features aren't pulled onto walls.
 * This is a visual approximation: features sharing one output footprint cannot all survive LOD.
 */
export function resamplePreview(grid:number[][],min:number,max:number,maxTriangles=MAX_PREVIEW_TRIANGLES) {
  const sourceRows=grid.length,sourceCols=grid[0]?.length??0;
  if(sourceRows<2||sourceCols<2||grid.some(row=>row.length!==sourceCols))throw Error('Invalid elevation grid for preview.');
  const {columns,rows}=previewDimensions(sourceCols,sourceRows,maxTriangles);
  const heights=new Float32Array(columns*rows);
  const stepX=(sourceCols-1)/(columns-1),stepY=(sourceRows-1)/(rows-1);
  const simplified=columns!==sourceCols||rows!==sourceRows;
  for(let j=0;j<rows;j++)for(let i=0;i<columns;i++){
    const x=i*stepX,y=j*stepY,x0=Math.floor(x),y0=Math.floor(y);
    let value:number;
    if(!simplified||i===0||j===0||i===columns-1||j===rows-1){
      const x1=Math.min(x0+1,sourceCols-1),y1=Math.min(y0+1,sourceRows-1),dx=x-x0,dy=y-y0;
      value=(grid[y0][x0]*(1-dx)+grid[y0][x1]*dx)*(1-dy)+(grid[y1][x0]*(1-dx)+grid[y1][x1]*dx)*dy;
    }else{
      let sum=0,count=0,low=Infinity,high=-Infinity;
      const left=Math.max(0,Math.ceil(x-stepX/2)),right=Math.min(sourceCols-1,Math.ceil(x+stepX/2)-1);
      const top=Math.max(0,Math.ceil(y-stepY/2)),bottom=Math.min(sourceRows-1,Math.ceil(y+stepY/2)-1);
      for(let r=top;r<=bottom;r++)for(let c=left;c<=right;c++){
        const h=grid[r][c];sum+=h;count++;low=Math.min(low,h);high=Math.max(high,h);
      }
      const mean=sum/count,up=high-mean,down=mean-low,threshold=(max-min)*.01;
      value=up>down*1.5&&up>threshold?high:down>up*1.5&&down>threshold?low:mean;
    }
    if(!Number.isFinite(value))throw Error('Preview contains missing elevation data.');
    heights[j*columns+i]=value;
  }
  return {heights,columns,rows};
}

function normals(positions:Float32Array,indices?:Uint32Array) {
  const out=new Float32Array(positions.length);
  const count=indices?.length??positions.length/3;
  for(let k=0;k<count;k+=3){
    const a=(indices?indices[k]:k)*3,b=(indices?indices[k+1]:k+1)*3,c=(indices?indices[k+2]:k+2)*3;
    const ux=positions[b]-positions[a],uy=positions[b+1]-positions[a+1],uz=positions[b+2]-positions[a+2];
    const vx=positions[c]-positions[a],vy=positions[c+1]-positions[a+1],vz=positions[c+2]-positions[a+2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    for(const p of [a,b,c]){out[p]+=nx;out[p+1]+=ny;out[p+2]+=nz}
  }
  for(let k=0;k<out.length;k+=3){const length=Math.hypot(out[k],out[k+1],out[k+2]);if(length){out[k]/=length;out[k+1]/=length;out[k+2]/=length}}
  return out;
}

export function buildPreviewGeometry(grid:number[][],min:number,max:number,maxTriangles=MAX_PREVIEW_TRIANGLES):PreviewBuffers {
  const {heights,columns,rows}=resamplePreview(grid,min,max,maxTriangles);
  // Normalised positions let width, relief, length and base use transforms, not new meshes.
  const range=Math.max(max-min,1),positions=new Float32Array(columns*rows*3);
  for(let j=0;j<rows;j++)for(let i=0;i<columns;i++){
    const p=(j*columns+i)*3;positions[p]=i/(columns-1)-.5;positions[p+1]=(heights[j*columns+i]-min)/range;positions[p+2]=j/(rows-1)-.5;
  }
  const indices=new Uint32Array((columns-1)*(rows-1)*6);let offset=0;
  for(let j=0;j<rows-1;j++)for(let i=0;i<columns-1;i++){
    const a=j*columns+i,b=a+1,c=a+columns,d=c+1;
    indices.set([a,c,b,b,c,d],offset);offset+=6;
  }
  const ring=[...Array(columns).keys(),...Array.from({length:rows-1},(_,j)=>(j+1)*columns+columns-1),
    ...Array.from({length:columns-1},(_,i)=>rows*columns-2-i),...Array.from({length:rows-2},(_,j)=>(rows-2-j)*columns)];
  const sidePositions=new Float32Array(ring.length*18);
  for(let k=0;k<ring.length;k++){
    const a=ring[k]*3,b=ring[(k+1)%ring.length]*3;
    const u=[positions[a],positions[a+1],positions[a+2]],v=[positions[b],positions[b+1],positions[b+2]];
    const bottomU=[u[0],0,u[2]],bottomV=[v[0],0,v[2]];
    sidePositions.set([...u,...v,...bottomU,...v,...bottomV,...bottomU],k*18);
  }
  return {positions,normals:normals(positions,indices),indices,sidePositions,sideNormals:normals(sidePositions),columns,rows,triangles:indices.length/3};
}
