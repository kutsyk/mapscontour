import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {buildLaserQuery,validateLaserRequest} from '../shared/laser-query.mjs';
import {validateOverpass} from '../server/laser.mjs';
const source=readFileSync(new URL('../src/laser/geometry.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const js=outputText.replaceAll('"polygon-clipping"',JSON.stringify(import.meta.resolve('polygon-clipping'))).replaceAll("'polygon-clipping'",JSON.stringify(import.meta.resolve('polygon-clipping')));
const {buildLaserSVG,defaultSettings,joinRings,clipLine,laserLayout}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const bounds=[0,0,.01,.01],p=(lon,lat)=>({lon,lat});
function build(elements,layer='buildings',operation='cut'){
 const settings=structuredClone(defaultSettings);settings.width=200;settings.margin=2;
 settings.layers=settings.layers.map(l=>({...l,enabled:l.id===layer,operation}));
 return buildLaserSVG({bounds,settings,elements,credits:{source:'fixture',attribution:'Test & <escaped>',license:'test'}});
}
test('physical SVG units, calculated aspect, operation layers and escaped credits',()=>{
 const result=build([{type:'way',id:1,tags:{building:'yes'},geometry:[p(.001,.001),p(.005,.001),p(.005,.005),p(.001,.001)]}]);
 assert.match(result.svg,/width="200mm"/);assert.match(result.svg,/data-operation="cut"/);
 assert.match(result.svg,/fill="none"/);assert.doesNotMatch(result.svg,/clipPath/);
 assert.match(result.svg,/Test &amp; &lt;escaped&gt;/);assert.equal(result.pathCount,1);
 const size=laserLayout([0,60,.01,60.01],200,2);assert.ok(size.height>390&&size.height<400);
});
test('line clipping removes off-frame coordinates without joining disjoint pieces',()=>{
 const lines=clipLine([[-5,2],[5,2],[15,2],[15,8],[5,8],[-5,8]],[0,0,10,10]);
 assert.equal(lines.length,2);assert.deepEqual(lines[0],[[0,2],[5,2],[10,2]]);assert.deepEqual(lines[1],[[10,8],[5,8],[0,8]]);
});
test('fragmented multipolygon rings join reversed members and retain inner holes',()=>{
 const a=[0,0],b=[1,0],c=[1,1],d=[0,1];
 assert.deepEqual(joinRings([[a,b],[c,b],[c,d],[a,d]])[0],[a,b,c,d,a]);
 const outer=[p(.001,.001),p(.009,.001),p(.009,.009),p(.001,.009),p(.001,.001)];
 const inner=[p(.003,.003),p(.006,.003),p(.006,.006),p(.003,.003)];
 const r=build([{type:'relation',id:10,tags:{type:'multipolygon',building:'yes'},members:[
  {type:'way',ref:1,role:'outer',geometry:outer.slice(0,3)},
  {type:'way',ref:2,role:'outer',geometry:outer.slice(2).reverse()},
  {type:'way',ref:3,role:'inner',geometry:inner}
 ]},{type:'way',id:1,tags:{building:'yes'},geometry:outer}]);
 assert.equal(r.pathCount,1);assert.match(r.svg,/fill-rule="evenodd"/);
 assert.equal((r.svg.match(/Z/g)||[]).length,2,'outer and inner contours must both be closed');
});
test('open area ways and incomplete relations are skipped with explicit warnings',()=>{
 const r=build([{type:'way',id:1,tags:{building:'yes'},geometry:[p(.001,.001),p(.003,.001),p(.003,.003)]},
  {type:'relation',id:2,tags:{type:'multipolygon',building:'yes'},members:[{type:'way',ref:1,role:'outer',geometry:[p(.001,.001),p(.003,.003)]}]}]);
 assert.equal(r.pathCount,0);assert(r.warnings.some(w=>w.includes('multipolygons')));assert(r.warnings.some(w=>w.includes('Unclosed')));
});
test('duplicate and reversed linework is not exported twice',()=>{
 const geom=[p(-.001,.005),p(.011,.005)];
 const r=build([{type:'way',id:1,tags:{highway:'primary'},geometry:geom},{type:'way',id:2,tags:{highway:'primary'},geometry:geom.slice().reverse()}],'majorRoads','score');
 assert.equal(r.pathCount,1);assert(r.warnings.some(w=>w.includes('Duplicate')));
});
test('concave polygons are physically clipped into separate components',()=>{
 // A U shape connected below the selected rectangle becomes two disconnected components.
 const geom=[p(.001,-.004),p(.009,-.004),p(.009,.008),p(.007,.008),p(.007,-.002),p(.003,-.002),p(.003,.008),p(.001,.008),p(.001,-.004)];
 const r=build([{type:'way',id:1,tags:{building:'yes'},geometry:geom}]);
 assert.equal(r.pathCount,1);assert.equal((r.svg.match(/Z/g)||[]).length,2);
 const d=r.svg.match(/ d="([^"]+)"/)[1],points=[...d.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)];
 for(const m of points){assert.ok(+m[1]>=2&&+m[1]<=198);assert.ok(+m[2]>=2&&+m[2]<=r.height-2+.0001)}
});
test('Overpass selection, bounds guards and query keys exclude display settings',()=>{
 const q=buildLaserQuery(bounds,['waterLines','buildings']);assert.match(q,/building.*!="no"/);assert.match(q,/river\|stream\|canal/);assert.doesNotMatch(q,/highway/);
 assert.equal(q,buildLaserQuery(bounds,['buildings','waterLines']));
 assert.throws(()=>validateLaserRequest([179,0,-179,1],['buildings']),/valid rectangle/);
 assert.throws(()=>buildLaserQuery([-1,-1,1,1],['buildings']),/local map area/);
 assert.throws(()=>buildLaserQuery(bounds,['invalid-layer']),/supported/);
 assert.throws(()=>validateOverpass({elements:[],remark:'timeout'}),/incomplete/);
});
