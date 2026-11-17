import {useEffect,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import type {PreviewBuffers} from './previewGeometry';

type ElevationPreview={grid:number[][];min:number;max:number;groundWidth:number};
type Props={preview:ElevationPreview|null;width:number;length:number;base:number;relief:number;viewToken:number;top:boolean};
type Settings=Pick<Props,'width'|'length'|'base'|'relief'>;
type SceneState={
  root:THREE.Group;surface:THREE.Mesh<THREE.BufferGeometry,THREE.MeshLambertMaterial>;
  walls:THREE.Mesh<THREE.BufferGeometry,THREE.MeshLambertMaterial>;stock:THREE.Mesh;
  worker:Worker;requestRender:()=>void;fit:()=>void;apply:(settings:Settings)=>void;
  data:{groundWidth:number;range:number}|null;settings:Settings;ready:boolean;
};

function updateGeometry(geometry:THREE.BufferGeometry,positions:Float32Array,normals:Float32Array,indices?:Uint32Array){
  const old=geometry.getAttribute('position'),oldIndex=geometry.getIndex();
  if(!old||old.array.length!==positions.length||(oldIndex?.array.length??0)!==(indices?.length??0)){
    geometry.dispose();geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));
    if(indices)geometry.setIndex(new THREE.BufferAttribute(indices,1));
  }else{
    (old.array as Float32Array).set(positions);old.needsUpdate=true;
    const normal=geometry.getAttribute('normal');(normal.array as Float32Array).set(normals);normal.needsUpdate=true;
    if(indices&&oldIndex){(oldIndex.array as Uint32Array).set(indices);oldIndex.needsUpdate=true}
  }
  geometry.computeBoundingBox();geometry.computeBoundingSphere();return geometry;
}

export function Terrain({preview,width,length,base,relief,viewToken,top}:Props){
  const host=useRef<HTMLDivElement>(null),runtime=useRef<SceneState|null>(null),requestId=useRef(0);
  const latest=useRef({width,length,base,relief,top});latest.current={width,length,base,relief,top};
  const [rebuilding,setRebuilding]=useState(false),[error,setError]=useState(''),[triangles,setTriangles]=useState(0);

  // Renderer, controls, materials, lighting and worker live for the whole mounted preview.
  useEffect(()=>{
    const el=host.current;if(!el)return;
    let renderer:THREE.WebGLRenderer;
    try{renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'})}
    catch{setError('3D preview requires WebGL. STL generation is still available.');return}
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
    renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.shadowMap.enabled=false;
    el.appendChild(renderer.domElement);renderer.domElement.setAttribute('aria-label','Wood terrain preview. Drag to rotate and scroll or pinch to zoom.');
    const scene=new THREE.Scene();scene.background=new THREE.Color('#eceae5');
    const camera=new THREE.PerspectiveCamera(38,1,.01,100000);camera.position.set(300,260,300);
    const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.12;
    const surfaceMaterial=new THREE.MeshLambertMaterial({color:'#d5b68b'});
    const sideMaterial=new THREE.MeshLambertMaterial({color:'#a17a50'});
    const baseMaterial=new THREE.MeshLambertMaterial({color:'#946e48'});
    const surface=new THREE.Mesh(new THREE.BufferGeometry(),surfaceMaterial);
    const walls=new THREE.Mesh(new THREE.BufferGeometry(),sideMaterial);
    const stock=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),baseMaterial);
    const root=new THREE.Group();root.visible=false;root.add(surface,walls,stock);scene.add(root);
    // Neutral fill and two diffuse lights, no shadow maps or real-time post-processing.
    scene.add(new THREE.AmbientLight(0xffffff,1.15));
    const key=new THREE.DirectionalLight(0xffffff,1.8);key.position.set(-2,4,2);scene.add(key);
    const fill=new THREE.DirectionalLight(0xffffff,.45);fill.position.set(3,1,-2);scene.add(fill);
    let frame=0,disposed=false,hasFit=false;
    const requestRender=()=>{
      if(disposed||frame)return;
      frame=requestAnimationFrame(()=>{
        frame=0;
        // OrbitControls emits change as damping settles; no frames remain scheduled at rest.
        const changed=controls.update();renderer.render(scene,camera);if(changed)requestRender();
      });
    };
    controls.addEventListener('change',requestRender);
    const worker=new Worker(new URL('./preview.worker.ts',import.meta.url),{type:'module'});
    const state:SceneState={root,surface,walls,stock,worker,requestRender,data:null,settings:latest.current,ready:false,
      apply(settings){
        state.settings=settings;if(!state.data||!state.ready)return;
        const height=state.data.range*settings.width/state.data.groundWidth*settings.relief;
        surface.scale.set(settings.width,Math.max(height,.000001),settings.length);surface.position.y=settings.base;
        walls.scale.copy(surface.scale);walls.position.y=settings.base;
        stock.scale.set(settings.width,settings.base,settings.length);stock.position.y=settings.base/2;
        const radius=Math.hypot(settings.width,settings.length,settings.base+height)/2;
        camera.near=Math.max(.001,radius/10000);camera.far=Math.max(1000,radius*1000);camera.updateProjectionMatrix();
        controls.minDistance=Math.max(.1,radius*.03);controls.maxDistance=radius*40;
        root.updateMatrixWorld(true);requestRender();
      },
      fit(){
        if(!state.ready)return;
        state.apply(latest.current);
        const box=new THREE.Box3().setFromObject(root),sphere=box.getBoundingSphere(new THREE.Sphere());
        const vfov=THREE.MathUtils.degToRad(camera.fov),hfov=2*Math.atan(Math.tan(vfov/2)*camera.aspect);
        const distance=sphere.radius/Math.sin(Math.min(vfov,hfov)/2)*1.12;
        // Flush any damping left from a previous orbit before setting an exact view.
        controls.enableDamping=false;controls.update();controls.enableDamping=true;
        controls.target.copy(sphere.center);
        const direction=latest.current.top?new THREE.Vector3(0,1,.0001):new THREE.Vector3(1,.85,1).normalize();
        camera.position.copy(sphere.center).addScaledVector(direction,distance);
        camera.lookAt(sphere.center);controls.update();controls.saveState();hasFit=true;requestRender();
      }
    };
    runtime.current=state;
    const resize=new ResizeObserver(()=>{
      if(!el.clientWidth||!el.clientHeight)return;
      renderer.setSize(el.clientWidth,el.clientHeight);camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();
      if(!hasFit&&state.ready)state.fit();requestRender();
    });resize.observe(el);
    requestRender();
    return()=>{
      disposed=true;cancelAnimationFrame(frame);worker.terminate();resize.disconnect();controls.removeEventListener('change',requestRender);controls.dispose();
      surface.geometry.dispose();walls.geometry.dispose();stock.geometry.dispose();surfaceMaterial.dispose();sideMaterial.dispose();baseMaterial.dispose();renderer.dispose();renderer.domElement.remove();runtime.current=null;
    };
  },[]);

  // Width/relief/base are transforms of the same normalised mesh. Debounce edits without
  // rebuilding buffers, resetting the camera, or showing a geometry loading indicator.
  useEffect(()=>{
    const timer=setTimeout(()=>runtime.current?.apply({width,length,base,relief}),160);
    return()=>clearTimeout(timer);
  },[width,length,base,relief]);

  useEffect(()=>{
    const state=runtime.current,id=++requestId.current;
    if(!state)return;
    if(!preview){state.root.visible=false;state.requestRender();setRebuilding(false);return}
    setError('');setRebuilding(true);
    const timer=setTimeout(()=>{
      state.worker.onmessage=(event:MessageEvent<{id:number;buffers?:PreviewBuffers;error?:string}>)=>{
        if(event.data.id!==requestId.current)return;
        if(event.data.error){setError(event.data.error);setRebuilding(false);return}
        const buffers=event.data.buffers!;
        state.surface.geometry=updateGeometry(state.surface.geometry,buffers.positions,buffers.normals,buffers.indices);
        state.walls.geometry=updateGeometry(state.walls.geometry,buffers.sidePositions,buffers.sideNormals);
        const first=!state.ready;
        state.data={groundWidth:preview.groundWidth,range:Math.max(preview.max-preview.min,1)};state.ready=true;state.root.visible=true;
        state.apply(latest.current);if(first)state.fit();state.requestRender();setTriangles(buffers.triangles);setRebuilding(false);
      };
      state.worker.onerror=()=>{if(id===requestId.current){setError('Preview geometry could not be built. Try refreshing the area.');setRebuilding(false)}};
      state.worker.postMessage({id,grid:preview.grid,min:preview.min,max:preview.max});
    },160);
    return()=>{clearTimeout(timer)};
  },[preview]);

  // Reset/top-view only move the camera. They do not touch elevation buffers or materials.
  useEffect(()=>{runtime.current?.fit()},[viewToken,top]);
  return <div className="terrain wood-preview">
    <div className="terrain-stage" ref={host}/>
    {rebuilding&&<div className="preview-status" role="status">Preparing terrain preview…</div>}
    {error&&<div className="preview-status preview-error" role="alert">{error}</div>}
    {!preview&&!error&&!rebuilding&&<div className="empty-preview">Select an area with valid elevation to see a 3D preview.</div>}
    {preview&&!error&&!rebuilding&&<small className="preview-detail">Wood relief · {triangles.toLocaleString()} preview triangles · STL detail unchanged</small>}
  </div>;
}
