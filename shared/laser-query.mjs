// Adapted from map-exporter/js/overpass.js. Shared by the local API and regression tests.
export const layerNames=['majorRoads','minorRoads','water','waterLines','parks','buildings','airports','railways'];
export function validateLaserRequest(bounds,layers,{large=false}={}){
  if(!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[0]>=bounds[2]||bounds[1]>=bounds[3]||bounds[0]<-180||bounds[2]>180||bounds[1]<-80||bounds[3]>80)throw Error('Use a valid rectangle within ±80° latitude, without crossing the date line.');
  const width=(bounds[2]-bounds[0])*111320*Math.cos((bounds[1]+bounds[3])/2*Math.PI/180),height=(bounds[3]-bounds[1])*111320;
  if(!large&&(width*height>400e6||width>40000||height>40000))throw Error('Public Overpass supports local map areas under 400 km² and 40 km per side here. For larger areas import an OSM extract or configure a dedicated Overpass endpoint.');
  if(!Array.isArray(layers)||!layers.length||layers.some(v=>!layerNames.includes(v)))throw Error('Choose at least one supported map layer.');
  return [...new Set(layers)].sort();
}
export function buildLaserQuery(bounds,layers,options={}){
  layers=validateLaserRequest(bounds,layers,options);
  const [w,s,e,n]=bounds,b=`(${s},${w},${n},${e})`,parts=[];
  const add=(selector,relations=false)=>{parts.push(`way${selector}${b};`);if(relations)parts.push(`relation["type"="multipolygon"]${selector}${b};`)};
  if(layers.includes('parks'))for(const t of ['["leisure"="park"]','["landuse"="grass"]','["landuse"="recreation_ground"]'])add(t,true);
  if(layers.includes('water'))for(const t of ['["natural"="water"]','["waterway"="riverbank"]'])add(t,true);
  if(layers.includes('waterLines'))add('["waterway"~"^(river|stream|canal)$"]');
  if(layers.includes('buildings'))add('["building"]["building"!="no"]',true);
  if(layers.includes('airports'))add('["aeroway"~"^(runway|taxiway|apron|terminal|hangar|helipad)$"]',true);
  if(layers.includes('railways'))add('["railway"="rail"]');
  const roads=[];
  if(layers.includes('majorRoads'))roads.push('motorway','trunk','primary');
  if(layers.includes('minorRoads'))roads.push('secondary','tertiary','residential','unclassified','service','living_street');
  if(roads.length)add(`["highway"~"^(${roads.join('|')})$"]`);
  return `[out:json][timeout:90];(\n${parts.join('\n')}\n);out body geom;`;
}
