import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/previewGeometry.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const {buildPreviewGeometry,resamplePreview,previewDimensions,MAX_PREVIEW_TRIANGLES}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));

test('LOD keeps the 200k terrain triangle budget for square, rectangular and thin grids',()=>{
  for(const [x,y] of [[90,90],[1025,1025],[4000,1000],[1000000,2],[2,1000000]]){
    const d=previewDimensions(x,y);
    assert.ok(d.columns>=2&&d.rows>=2);
    assert.ok(d.columns<=x&&d.rows<=y);
    assert.ok(2*(d.columns-1)*(d.rows-1)<=MAX_PREVIEW_TRIANGLES);
  }
  assert.deepEqual(previewDimensions(90,90),{columns:90,rows:90});
});
test('downsampling preserves isolated important peaks and valleys without mutating elevation input',()=>{
  const grid=Array.from({length:1001},()=>Array(1001).fill(500));
  grid[401][401]=2500;grid[701][701]=-500;
  const lod=resamplePreview(grid,-500,2500,80000);
  assert.equal(Math.max(...lod.heights),2500);
  assert.equal(Math.min(...lod.heights),-500);
  assert.equal(grid.length,1001);assert.equal(grid[401][401],2500);assert.equal(grid[701][701],-500);
});
test('a planar slope stays planar and source corners remain exact under LOD',()=>{
  const grid=Array.from({length:101},(_,j)=>Array.from({length:121},(_,i)=>i*2+j*3));
  const lod=resamplePreview(grid,0,540,2000);
  assert.equal(lod.heights[0],0);assert.equal(lod.heights.at(-1),540);
  for(let j=0;j<lod.rows;j++)for(let i=0;i<lod.columns;i++){
    const expected=i/(lod.columns-1)*240+j/(lod.rows-1)*300;
    assert.ok(Math.abs(lod.heights[j*lod.columns+i]-expected)<=3,'box average should preserve the overall slope');
  }
});
test('normalised mesh retains physical width, length, relief and a separate solid base',()=>{
  const grid=[[100,120,140],[110,130,150],[120,140,160]];
  const b=buildPreviewGeometry(grid,100,160);
  assert.equal(b.triangles,8);assert.equal(b.indices.length,24);
  const width=200,length=120,base=4,groundWidth=1000,relief=2;
  const heightScale=60*width/groundWidth*relief;
  const heights=[];
  for(let i=0;i<b.positions.length;i+=3){
    assert.ok(b.positions[i]*width>=-width/2&&b.positions[i]*width<=width/2);
    assert.ok(b.positions[i+2]*length>=-length/2&&b.positions[i+2]*length<=length/2);
    heights.push(base+b.positions[i+1]*heightScale);
    assert.ok(b.normals[i+1]>0,'terrain normals face up');
  }
  assert.equal(Math.min(...heights),4);assert.equal(Math.max(...heights),28);
  // Each wall quad starts at the matching boundary vertex and ends at the top of the base.
  const point=[...b.sidePositions.slice(0,3)];assert.deepEqual(point,[...b.positions.slice(0,3)]);
  assert.equal(b.sidePositions[7],0);
  assert.equal(b.sidePositions.length,8*18);
});
test('flat terrain has finite normals, zero terrain relief and no artificial spikes',()=>{
  const b=buildPreviewGeometry([[500,500],[500,500]],500,500);
  for(let i=1;i<b.positions.length;i+=3)assert.equal(b.positions[i],0);
  for(const value of [...b.normals,...b.sideNormals])assert.ok(Number.isFinite(value));
  assert.equal(b.triangles,2);
});
test('invalid elevation is rejected rather than uploading NaN geometry',()=>{
  assert.throws(()=>buildPreviewGeometry([[1,2],[3,NaN]],1,3),/missing elevation/);
  assert.throws(()=>buildPreviewGeometry([[1,2],[3]],1,3),/Invalid elevation grid/);
});
