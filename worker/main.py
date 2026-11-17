import sys, json, math, pathlib
import numpy as np
import trimesh
from providers import sample, metadata
from grid import layout
from mapterhorn import sample_online

def emit(**kwargs):
    print(json.dumps(kwargs),flush=True)

def dimensions(b):
    target=layout(b)
    return target['width'],target['length']

def mesh_grid(z,width,length):
    ny,nx=z.shape
    x,y=np.meshgrid(np.linspace(0,width,nx),np.linspace(length,0,ny))
    vertices=np.column_stack((x.ravel(),y.ravel(),z.ravel())).tolist()
    faces=[]
    for j in range(ny-1):
        for i in range(nx-1):
            a=j*nx+i; b=a+1; c=a+nx; d=c+1
            faces.extend([[a,c,b],[b,c,d]])
    ring=list(range(nx))+[j*nx+nx-1 for j in range(1,ny)]+list(range(ny*nx-2,(ny-1)*nx-1,-1))+[j*nx for j in range(ny-2,0,-1)]
    bottom=[]
    for a in ring:
        bottom.append(len(vertices)); vertices.append([vertices[a][0],vertices[a][1],0])
    center=len(vertices);vertices.append([width/2,length/2,0])
    for k,a in enumerate(ring):
        n=(k+1)%len(ring); b=ring[n]; u=bottom[k];v=bottom[n]
        faces.extend([[a,b,u],[b,v,u],[center,u,v]])
    mesh=trimesh.Trimesh(vertices=vertices,faces=faces,process=True)
    if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume<=0:
        raise ValueError('Mesh validation failed: surface is not a consistently oriented closed solid.')
    return mesh

def run(req):
    if req['action']=='metadata':
        emit(result=metadata(req['path']));return
    b=req['bounds'];w,h=dimensions(b)
    if req['action']=='dimensions':
        emit(result=dict(groundWidth=w,groundLength=h));return
    nx=req.get('nx',80);ny=req.get('ny',80)
    credits=None
    if req.get('provider')=='mapterhorn':
        desired_spacing=w*req.get('spacing',.8)/req.get('width',200)
        z,credits=sample_online(b,nx,ny,desired_spacing,progress=emit)
    else:
        z=sample(req.get('path'),b,nx,ny)

    if req['action']=='preview':
        emit(result=dict(grid=z.tolist(),min=float(z.min()),max=float(z.max()),groundWidth=w,groundLength=h,sourceMetadata=credits));return
    emit(progress=20,message='Elevation clipped. Building solid tiles…')
    width=req['width'];length=width*h/w
    minimum=float(z.min()); maximum=float(z.max())
    z=(z-minimum)*width/w*req['relief']+req['base']
    files=[]
    for row in range(req['down']):
        for col in range(req['across']):
            x0=col*((nx-1)//req['across']);x1=(col+1)*((nx-1)//req['across'])
            y0=row*((ny-1)//req['down']);y1=(row+1)*((ny-1)//req['down'])
            mesh=mesh_grid(z[y0:y1+1,x0:x1+1],width/req['across'],length/req['down'])
            name=f'terrain-{row+1}-{col+1}.stl'
            mesh.export(str(pathlib.Path(req['output'])/name),file_type='stl')
            files.append(name)
            emit(progress=20+75*len(files)/(req['across']*req['down']),message=f'Validated tile {len(files)}: watertight, consistent normals')
    credit={k:v for k,v in req.items() if k not in ('path','output')}
    credit.update(sourceMetadata=credits, groundWidthMetres=w, groundLengthMetres=h, outputGridSpacingMetres=[w/(nx-1),h/(ny-1)],actualElevationMin=minimum, actualElevationMax=maximum, actualTotalThickness=float(z.max()), units='millimetres',source=req.get('source'),attribution=req.get('attribution'),validation='Watertight, consistent winding, positive volume; binary STL')
    pathlib.Path(req['output'],'settings-credits.json').write_text(json.dumps(credit,indent=2))
    emit(result=dict(files=files+['settings-credits.json']))

if __name__=='__main__':
    try: run(json.load(sys.stdin))
    except Exception as e:
        emit(error=str(e));sys.exit(1)
