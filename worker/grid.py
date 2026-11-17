"""One local metric grid shared by every provider and STL generation."""
from rasterio.crs import CRS
from rasterio.warp import transform_bounds
from rasterio.transform import from_bounds

def layout(bounds, nx=2, ny=2):
    west,south,east,north=bounds
    crs=CRS.from_string(f'+proj=tmerc +lat_0={(south+north)/2} +lon_0={(west+east)/2} +k=1 +datum=WGS84 +units=m +no_defs')
    left,bottom,right,top=transform_bounds('EPSG:4326',crs,*bounds,densify_pts=41)
    width=right-left; length=top-bottom
    dx=width/(nx-1);dy=length/(ny-1)
    # Mesh nodes, including the edges, coincide with raster pixel centres.
    affine=from_bounds(left-dx/2,bottom-dy/2,right+dx/2,top+dy/2,nx,ny)
    return dict(crs=crs,transform=affine,width=width,length=length,bounds=(left,bottom,right,top),spacing=(dx,dy))
