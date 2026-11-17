export type Bounds = [number, number, number, number];
export type Handle = 'center' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const handles: Handle[] = ['center', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const minimum = 0.000001;
export function handlePosition(b: Bounds, handle: Handle): [number, number] {
  return [handle.includes('w') ? b[0] : handle.includes('e') && handle !== 'center' ? b[2] : (b[0]+b[2])/2,
    handle.includes('n') && handle !== 'center' ? b[3] : handle.includes('s') ? b[1] : (b[1]+b[3])/2];
}
export function moveHandle(start: Bounds, handle: Handle, lng: number, lat: number): Bounds {
  const b: Bounds = [...start];
  if (handle === 'center') {
    const dx = clamp(lng-(start[0]+start[2])/2, -180-start[0], 180-start[2]);
    const dy = clamp(lat-(start[1]+start[3])/2, -80-start[1], 80-start[3]);
    return [start[0]+dx,start[1]+dy,start[2]+dx,start[3]+dy];
  }
  if (handle.includes('w')) b[0] = clamp(lng,-180,start[2]-minimum);
  if (handle.includes('e')) b[2] = clamp(lng,start[0]+minimum,180);
  if (handle.includes('s')) b[1] = clamp(lat,-80,start[3]-minimum);
  if (handle.includes('n')) b[3] = clamp(lat,start[1]+minimum,80);
  return b;
}
export function containsBounds(coverage: Bounds, b: Bounds) {
  return b[0]>=coverage[0] && b[1]>=coverage[1] && b[2]<=coverage[2] && b[3]<=coverage[3];
}
export function insetBounds(b: Bounds): Bounds {
  const dx=(b[2]-b[0])*.02, dy=(b[3]-b[1])*.02;
  return [b[0]+dx,b[1]+dy,b[2]-dx,b[3]-dy];
}
export function selectionPolygon(b: Bounds) {
  return {type:'Feature' as const,properties:{},geometry:{type:'Polygon' as const,
    coordinates:[[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]],[b[0],b[1]]]]}};
}
