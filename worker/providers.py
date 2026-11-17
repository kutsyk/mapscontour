"""Synthetic/local providers return the shared local metric grid in metres."""
import numpy as np
import rasterio
from rasterio.warp import reproject, transform_bounds, Resampling
from rasterio.warp import transform
from grid import layout

SAMPLE_BOUNDS = [-122.0, 46.78, -121.65, 47.02]

def metadata(path):
    with rasterio.open(path) as ds:
        if not ds.crs or ds.count != 1:
            raise ValueError('Use a single-band GeoTIFF with a defined coordinate reference system.')
        if ds.scales[0] != 1 or ds.offsets[0] != 0:
            raise ValueError('Convert scaled elevation values to metres before import.')
        if ds.units[0] and ds.units[0].lower() not in ('m', 'metre', 'meter', 'metres', 'meters'):
            raise ValueError('Elevation band must use metres. Convert feet or other units before importing.')
        b = list(transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds, densify_pts=41))
        lat = (b[1]+b[3])/2
        resolution = max((b[2]-b[0])*111320*np.cos(np.radians(lat))/ds.width, (b[3]-b[1])*111320/ds.height)
        return dict(bounds=b, resolution=round(float(resolution),2), crs=str(ds.crs), limitations='Vertical values must be metres. Unknown vertical datum and attribution: verify your source. Coverage is checked at the requested grid nodes.')

def sample(path, bounds, nx, ny):
    if path is None:
        if any([bounds[0]<SAMPLE_BOUNDS[0], bounds[1]<SAMPLE_BOUNDS[1], bounds[2]>SAMPLE_BOUNDS[2], bounds[3]>SAMPLE_BOUNDS[3]]):
            raise ValueError('Selected area is outside the sample terrain. Use the sample extent or import your own DEM.')
        target=layout(bounds,nx,ny)
        xx,yy=np.meshgrid(np.linspace(target['bounds'][0],target['bounds'][2],nx),np.linspace(target['bounds'][3],target['bounds'][1],ny))
        x,y=transform(target['crs'],'EPSG:4326',xx.ravel().tolist(),yy.ravel().tolist())
        x=np.array(x).reshape(ny,nx);y=np.array(y).reshape(ny,nx)
        x=(x+121.82)*16; y=(y-46.9)*20
        return 500+2100*np.exp(-0.7*(x*x+y*y))+180*np.sin(x*5+y*2)*np.exp(-0.25*(x*x+y*y))
    meta=metadata(path)
    b=meta['bounds']
    if bounds[0]<b[0] or bounds[1]<b[1] or bounds[2]>b[2] or bounds[3]>b[3]:
        raise ValueError('Selected area extends outside the DEM. Move or shrink the rectangle to fit its coverage.')
    target=layout(bounds,nx,ny)
    out=np.full((ny,nx),np.nan,dtype='float64')
    with rasterio.open(path) as ds:
        reproject(rasterio.band(ds,1),out,src_transform=ds.transform,src_crs=ds.crs,src_nodata=ds.nodata,dst_transform=target['transform'],dst_crs=target['crs'],dst_nodata=np.nan,resampling=Resampling.bilinear)
    if not np.isfinite(out).all():
        raise ValueError('Insufficient DEM coverage: the selected area contains NoData or invalid elevation. Choose a smaller area without gaps.')
    return out
