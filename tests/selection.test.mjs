import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/selection.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const {handlePosition,moveHandle,containsBounds,insetBounds}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
const b=[10,20,14,26];
test('center drag translates all four sides without changing size',()=>{
  assert.deepEqual(handlePosition(b,'center'),[12,23]);
  assert.deepEqual(moveHandle(b,'center',15,21),[13,18,17,24]);
});
test('all four sides resize independently with opposite edge anchored',()=>{
  assert.deepEqual(moveHandle(b,'n',100,30),[10,20,14,30]);
  assert.deepEqual(moveHandle(b,'s',100,18),[10,18,14,26]);
  assert.deepEqual(moveHandle(b,'e',18,70),[10,20,18,26]);
  assert.deepEqual(moveHandle(b,'w',8,70),[8,20,14,26]);
});
test('all four corners move both adjacent edges',()=>{
  for(const [handle,expected] of [['nw',[8,20,14,30]],['ne',[10,20,18,30]],['sw',[8,18,14,26]],['se',[10,18,18,26]]]){
    const lng=handle.includes('w')?8:18,lat=handle.includes('n')?30:18;
    assert.deepEqual(moveHandle(b,handle,lng,lat),expected);
    assert.deepEqual(handlePosition(expected,handle),[lng,lat]);
  }
});
test('resize cannot invert or collapse; center stops at world limits',()=>{
  const resized=moveHandle(b,'sw',50,50);
  assert.ok(resized[0]<resized[2]);assert.ok(resized[1]<resized[3]);
  assert.deepEqual(moveHandle(b,'center',200,90),[176,74,180,80]);
  assert.deepEqual(moveHandle(b,'center',-200,-90),[-180,-80,-176,-74]);
});
test('sample coverage detects outside selections and reset gives safe bounds',()=>{
  const coverage=[-122,46.78,-121.65,47.02];
  assert.equal(containsBounds(coverage,[-121.98,46.8,-121.67,47]),true);
  assert.equal(containsBounds(coverage,[0,0,1,1]),false);
  assert.equal(containsBounds(coverage,[-122.01,46.8,-121.67,47]),false);
  assert.equal(containsBounds(coverage,insetBounds(coverage)),true);
});
