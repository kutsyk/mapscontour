import clipping from 'polygon-clipping';
import type {Pair,Ring,MultiPolygon} from 'polygon-clipping';
export type Bounds=[number,number,number,number];
export type LayerName='majorRoads'|'minorRoads'|'water'|'waterLines'|'parks'|'buildings'|'airports'|'railways';
export type Layer={id:LayerName;name:string;enabled:boolean;color:string;operation:'cut'|'score'|'engrave';stroke:number};
export type LaserSettings={sourceId?:string;width:number;margin:number;units:'mm'|'in';frame:boolean;layers:Layer[];roadColors:Record<string,string>};
export type Coordinate={lon:number;lat:number};
export type Element={type:string;id:number;tags?:Record<string,string>;geometry?:Coordinate[];members?:{type:string;ref:number;role:string;geometry?:Coordinate[]}[]};
export const defaultLayers:Layer[]=[
  {id:'majorRoads',name:'Major roads',enabled:true,color:'#da442c',operation:'score',stroke:.2},
  {id:'minorRoads',name:'Minor roads',enabled:true,color:'#272727',operation:'score',stroke:.15},
  {id:'buildings',name:'Buildings',enabled:true,color:'#cf3030',operation:'cut',stroke:.1},
  {id:'water',name:'Water areas',enabled:true,color:'#316cba',operation:'engrave',stroke:.15},
  {id:'waterLines',name:'Rivers / streams',enabled:false,color:'#316cba',operation:'score',stroke:.15},
  {id:'parks',name:'Parks / grass',enabled:false,color:'#508968',operation:'engrave',stroke:.15},
  {id:'airports',name:'Airport infrastructure',enabled:false,color:'#a563b4',operation:'score',stroke:.2},
  {id:'railways',name:'Railways',enabled:false,color:'#6f42c1',operation:'score',stroke:.15}
];
export const defaultSettings:LaserSettings={width:250,margin:2,units:'mm',frame:false,layers:defaultLayers,roadColors:{}};
const R=6378137;
const x=(lon:number)=>R*lon*Math.PI/180;
const y=(lat:number)=>R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
const equal=(a:Pair,b:Pair)=>Math.abs(a[0]-b[0])<1e-8&&Math.abs(a[1]-b[1])<1e-8;
const xml=(s:unknown)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const number=(n:number)=>Number(n.toFixed(4)).toString();
export function laserLayout(bounds:Bounds,width:number,margin:number){
  const [w,s,e,n]=bounds;
  if(!bounds.every(Number.isFinite)||w>=e||s>=n||w< -180||e>180||s< -80||n>80)throw Error('Invalid map bounds.');
  if(!Number.isFinite(width)||width<20||width>2000||!Number.isFinite(margin)||margin<0||margin*2>=width)throw Error('Choose a valid model width and margin.');
  const spanX=x(e)-x(w),spanY=y(n)-y(s),scale=(width-margin*2)/spanX,height=margin*2+spanY*scale;
  if(height>4000)throw Error('Map is too tall. Choose a wider rectangle or a smaller output width.');
  return {width,height,margin,groundWidth:spanX*Math.cos((s+n)*Math.PI/360),project:(p:Coordinate):Pair=>[margin+(x(p.lon)-x(w))*scale,margin+(y(n)-y(p.lat))*scale]};
}
export function matchesLayer(e:Element,id:LayerName){
  const t=e.tags||{};
  switch(id){
    case 'majorRoads':return /^(motorway|trunk|primary)$/.test(t.highway||'');
    case 'minorRoads':return /^(secondary|tertiary|residential|unclassified|service|living_street)$/.test(t.highway||'');
    case 'water':return t.natural==='water'||t.waterway==='riverbank';
    case 'waterLines':return /^(river|stream|canal)$/.test(t.waterway||'');
    case 'parks':return t.leisure==='park'||t.landuse==='grass'||t.landuse==='recreation_ground';
    case 'buildings':return !!t.building&&t.building!=='no';
    case 'airports':return /^(runway|taxiway|apron|terminal|hangar|helipad)$/.test(t.aeroway||'');
    case 'railways':return t.railway==='rail';
  }
}
export function joinRings(parts:Ring[]):Ring[]{
  const pending=parts.map(p=>p.slice()),rings:Ring[]=[];
  while(pending.length){
    const ring=pending.shift()!;
    while(!equal(ring[0],ring[ring.length-1])){
      const end=ring[ring.length-1];
      const choices=pending.map((p,i)=>({p,i,reverse:equal(end,p[p.length-1])})).filter(v=>equal(end,v.p[0])||v.reverse);
      if(choices.length!==1)throw Error('Incomplete or ambiguous multipolygon ring');
      const {p,i,reverse}=choices[0];pending.splice(i,1);ring.push(...(reverse?p.slice().reverse():p).slice(1));
    }
    if(ring.length<4)throw Error('Degenerate polygon ring');rings.push(ring);
  }
  return rings;
}
/** Actual segment clipping: no SVG clipPath that a laser editor might discard. */
export function clipLine(points:Pair[],box:[number,number,number,number]):Pair[][]{
  const [left,top,right,bottom]=box,lines:Pair[][]=[];let current:Pair[]=[];
  const flush=()=>{if(current.length>=2)lines.push(current);current=[]};
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1];let lo=0,hi=1,valid=true;
    const p=[-dx,dx,-dy,dy],q=[a[0]-left,right-a[0],a[1]-top,bottom-a[1]];
    for(let j=0;j<4;j++){
      if(p[j]===0){if(q[j]<0){valid=false;break}}
      else{const t=q[j]/p[j];if(p[j]<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi){valid=false;break}}
    }
    if(!valid){flush();continue}
    const start:Pair=[a[0]+lo*dx,a[1]+lo*dy],end:Pair=[a[0]+hi*dx,a[1]+hi*dy];
    if(equal(start,end))continue;
    if(current.length&&!equal(current[current.length-1],start))flush();
    if(!current.length)current.push(start);current.push(end);if(hi<1)flush();
  }
  flush();return lines;
}
function path(points:Pair[],closed=false){return points.map((p,i)=>`${i?'L':'M'}${number(p[0])},${number(p[1])}`).join('')+(closed?'Z':'')}
export function buildLaserSVG({bounds,settings,elements,credits,onProgress=()=>{}}:{bounds:Bounds;settings:LaserSettings;elements:Element[];credits:Record<string,unknown>;onProgress?:(n:number,message:string)=>void}){
  const layout=laserLayout(bounds,settings.width,settings.margin),{width,height,margin}=layout;
  const box:[number,number,number,number]=[margin,margin,width-margin,height-margin];
  const clip:Ring=[[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]],[box[0],box[1]]];
  const notes=new Map<string,number>(),seen=new Set<string>(),counts:Record<string,number>={},groups:string[]=[];
  const note=(s:string)=>notes.set(s,(notes.get(s)||0)+1);
  const coords=(g:Coordinate[]|undefined):Ring=>{
    if(!g||g.length<2||g.some(p=>!p||!Number.isFinite(p.lon)||!Number.isFinite(p.lat)||Math.abs(p.lat)>85||Math.abs(p.lon)>180))throw Error('Invalid geometry');
    return g.map(layout.project);
  };
  let paths=0;
  for(const [li,layer] of settings.layers.entries()){
    if(!layer.enabled)continue;
    if(!/^#[0-9a-f]{6}$/i.test(layer.color)||!['cut','score','engrave'].includes(layer.operation)||!Number.isFinite(layer.stroke)||layer.stroke<.01||layer.stroke>5)throw Error('Invalid layer color, operation or stroke width.');
    const members=new Set<number>(),out:string[]=[];
    const emit=(e:Element,isArea:boolean,polygon:MultiPolygon|undefined,line:Pair[]|undefined)=>{
      let d='';
      if(isArea){
        const cut=clipping.intersection(polygon!,[clip]);d=cut.flatMap(poly=>poly.map(r=>path(r,true))).join('');
      }else d=clipLine(line!,box).map(r=>path(r)).join('');
      if(!d)return false;
      const reversed=isArea?d:clipLine(line!.slice().reverse(),box).map(r=>path(r)).join('');
      const key=layer.operation+':'+(d<reversed?d:reversed);
      if(seen.has(key)){note('Duplicate paths removed');return true}seen.add(key);
      let color=layer.color;
      if(e.tags?.highway){const road=e.tags.highway,override=settings.roadColors[road]||(/^(residential|unclassified|service|living_street)$/.test(road)?settings.roadColors.local:undefined);if(override&&/^#[0-9a-f]{6}$/i.test(override))color=override}
      const fill=layer.operation==='engrave'&&isArea;
      out.push(`<path data-osm="${xml(e.type)}-${e.id}" d="${d}" fill="${fill?color:'none'}" fill-rule="evenodd" stroke="${fill?'none':color}" stroke-width="${number(layer.stroke)}" stroke-linejoin="round" stroke-linecap="round"/>`);
      paths++;return true;
    };
    // Process complete relations first, then suppress their tagged member ways in this layer.
    for(const e of elements.filter(e=>e.type==='relation'&&matchesLayer(e,layer.id))){
      if(e.tags?.type!=='multipolygon'){note('Non-multipolygon relations skipped');continue}
      try{
        const relevant=(e.members||[]).filter(m=>m.type==='way');
        const outer=joinRings(relevant.filter(m=>m.role!=='inner').map(m=>coords(m.geometry)));
        const inner=joinRings(relevant.filter(m=>m.role==='inner').map(m=>coords(m.geometry)));
        if(!outer.length)throw Error('Missing outer ring');
        const areas=clipping.union(outer.map(r=>[r]));
        const polygon=inner.length?clipping.difference(areas,inner.map(r=>[r])):areas;
        if(emit(e,true,polygon,undefined))for(const m of relevant)members.add(m.ref);
      }catch{note('Incomplete or invalid multipolygons skipped')}
    }
    for(const e of elements){
      if(e.type!=='way'||!matchesLayer(e,layer.id)||members.has(e.id))continue;
      try{
        const line=coords(e.geometry),closed=line.length>=4&&equal(line[0],line[line.length-1]);
        const areaLayer=['water','parks','buildings'].includes(layer.id);
        const isArea=areaLayer||(layer.id==='airports'&&closed&&e.tags?.area!=='no');
        if(isArea&&!closed){note('Unclosed area ways skipped');continue}
        emit(e,isArea,isArea?[[line]]:undefined,line);
      }catch{note('Invalid feature geometries skipped')}
    }
    counts[layer.id]=out.length;
    groups.push(`<g id="${layer.id}" data-operation="${layer.operation}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:groupmode="layer" inkscape:label="${xml(layer.name+' · '+layer.operation)}">${out.join('')}</g>`);
    onProgress(65+(li+1)/settings.layers.length*25,`${layer.name}: ${out.length} paths`);
  }
  if(settings.frame){groups.push(`<g id="frame" data-operation="cut"><rect x="0" y="0" width="${number(width)}" height="${number(height)}" fill="none" stroke="#ff0000" stroke-width="0.1"/></g>`);paths++}
  const warnings=[...notes].map(([text,count])=>`${text}: ${count}`);
  if(!paths)warnings.push('No exportable paths found. OSM may have no matching data here; try another area or layer.');
  const metadata={...credits,feature:'laser-map',bounds,widthMm:width,heightMm:height,settings,counts,pathCount:paths,warnings,projection:'Web Mercator, uniformly scaled to physical SVG millimetres; local ground scale approximate',manufacturing:'Roads are centerlines. No kerf compensation, island/connectivity checks, bridges or laser power/speed configuration.'};
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}mm" height="${number(height)}mm" viewBox="0 0 ${number(width)} ${number(height)}"><title>MapsContour laser map</title><desc>${xml(credits.attribution||'© OpenStreetMap contributors')} — ${xml(credits.licenseUrl||'')}. ${xml(credits.license||'')}. Set operations, speed and power in your laser software.</desc><metadata>${xml(JSON.stringify(metadata))}</metadata>${groups.join('')}</svg>`;
  return {svg,credits:metadata,width,height,pathCount:paths,counts,warnings};
}
