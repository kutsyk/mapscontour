import maplibregl from 'maplibre-gl';
import {handles, handlePosition, moveHandle, selectionPolygon, type Bounds, type Handle} from './selection';

const labels: Record<Handle,string> = {
  center:'Move selection', n:'Resize north edge', ne:'Resize northeast corner',
  e:'Resize east edge', se:'Resize southeast corner', s:'Resize south edge',
  sw:'Resize southwest corner', w:'Resize west edge', nw:'Resize northwest corner'
};
/** Draw locally while dragging; commit once on release so Python is not called on every move. */
export class RectangleEditor {
  private bounds: Bounds;
  private markers = new Map<Handle,maplibregl.Marker>();
  private dragStart: Bounds | null = null;
  constructor(private map: maplibregl.Map, bounds: Bounds, private commit: (b: Bounds)=>void) {
    this.bounds=bounds;
    for (const handle of handles) {
      const button=document.createElement('button');
      button.type='button';
      button.className=`selection-handle handle-${handle}`;
      button.setAttribute('aria-label',labels[handle]);
      button.title=labels[handle]+' · drag or use arrow keys';
      const icon=document.createElement('span');
      icon.textContent=handle==='center'?'✥':'';
      button.append(icon);
      button.addEventListener('click',e=>e.stopPropagation());
      button.addEventListener('dblclick',e=>e.stopPropagation());
      const marker=new maplibregl.Marker({element:button,draggable:true,clickTolerance:3})
        .setLngLat(handlePosition(bounds,handle)).addTo(map);
      marker.on('dragstart',()=>{this.map.stop();this.dragStart=[...this.bounds];button.classList.add('dragging')});
      marker.on('drag',()=>{
        const p=marker.getLngLat();
        this.update(moveHandle(this.dragStart || this.bounds,handle,p.lng,p.lat));
      });
      marker.on('dragend',()=>{
        button.classList.remove('dragging');this.dragStart=null;
        this.commit([...this.bounds]);
      });
      button.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
        e.preventDefault();e.stopPropagation();
        const [lng,lat]=handlePosition(this.bounds,handle);
        const amount=e.shiftKey ? 0.1 : 0.01;
        const dx=(this.bounds[2]-this.bounds[0])*amount;
        const dy=(this.bounds[3]-this.bounds[1])*amount;
        this.update(moveHandle(this.bounds,handle,lng+(e.key==='ArrowLeft'?-dx:e.key==='ArrowRight'?dx:0),lat+(e.key==='ArrowDown'?-dy:e.key==='ArrowUp'?dy:0)));
        this.commit([...this.bounds]);
      });
      this.markers.set(handle,marker);
    }
    this.update(bounds);
  }
  update(bounds: Bounds) {
    this.bounds=bounds;
    (this.map.getSource('selection') as maplibregl.GeoJSONSource)?.setData(selectionPolygon(bounds));
    for(const [handle,marker] of this.markers)marker.setLngLat(handlePosition(bounds,handle));
  }
  setVisible(visible: boolean) {
    for(const marker of this.markers.values())marker.getElement().hidden=!visible;
  }
  remove() { for(const marker of this.markers.values())marker.remove();this.markers.clear(); }
}
