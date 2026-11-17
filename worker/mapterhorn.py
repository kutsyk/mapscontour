"""Explicit online provider. No other elevation service is contacted."""
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds, Resampling
from grid import layout

TILEJSON='https://tiles.mapterhorn.com/tilejson.json'
CATALOGUE='https://download.mapterhorn.com/attribution.json'
DOWNLOADS='https://download.mapterhorn.com/download_urls.json'
ATTRIBUTION='https://mapterhorn.com/attribution/'
CACHE=Path(__file__).resolve().parents[1]/'data'/'cache'/'mapterhorn'
WORLD=2*math.pi*6378137
MAX_TILES=64

class TileMissing(ValueError): pass

def plain(text):
    from html import unescape
    import re
    return unescape(re.sub('<[^>]*>','',str(text or '')))

class Client:
    def __init__(self,cache=CACHE,opener=urllib.request.urlopen,progress=lambda **v:None):
        self.cache=Path(cache);self.opener=opener;self.progress=progress
        self.stop=threading.Event();self.deadline=time.monotonic()+180

    def get(self,url,ttl=86400,validate=None):
        parsed=urllib.parse.urlparse(url)
        if parsed.scheme!='https' or parsed.hostname not in ('tiles.mapterhorn.com','download.mapterhorn.com'):
            raise ValueError('Unexpected Mapterhorn metadata URL; refusing to contact another service.')
        key=hashlib.sha256(url.encode()).hexdigest();target=self.cache/key
        if target.exists() and time.time()-target.stat().st_mtime<ttl:
            data=target.read_bytes()
            try:
                if validate:validate(data)
                return data
            except Exception: target.unlink(missing_ok=True)
        last=None
        for attempt in range(3):
            if self.stop.is_set():raise ValueError('Elevation fetch cancelled.')
            if time.monotonic()>self.deadline:raise ValueError('Elevation download exceeded 180 seconds. Select a smaller area or import a GeoTIFF.')
            try:
                request=urllib.request.Request(url,headers={'User-Agent':'MapsContour-LocalWorkshop/0.1 (+https://mapterhorn.com/)','Accept':'*/*'})
                with self.opener(request,timeout=15) as response:
                    final=urllib.parse.urlparse(response.geturl())
                    if final.scheme!='https' or final.hostname!=parsed.hostname:
                        raise ValueError('Unexpected redirect from Mapterhorn.')
                    data=response.read(8*1024*1024+1)
                    if len(data)>8*1024*1024:raise ValueError('Mapterhorn response exceeded the 8 MiB limit.')
                if validate:validate(data)
                self.cache.mkdir(parents=True,exist_ok=True)
                fd,tmp=tempfile.mkstemp(prefix='.partial-',dir=self.cache)
                try:
                    with os.fdopen(fd,'wb') as f:f.write(data)
                    os.replace(tmp,target)
                finally:
                    if os.path.exists(tmp):os.unlink(tmp)
                return data
            except urllib.error.HTTPError as e:
                if e.code in (404,410):raise TileMissing('Mapterhorn has no elevation tile for part of this selection. Import a GeoTIFF or try a different area.') from e
                if e.code not in (408,429,500,502,503,504):
                    raise ValueError(f'Mapterhorn refused the request (HTTP {e.code}). Try later or import a GeoTIFF.') from e
                last=e
                try:delay=min(5,max(.5,float(e.headers.get('Retry-After',2**attempt))))
                except (ValueError,TypeError):delay=2**attempt
            except (urllib.error.URLError,TimeoutError,OSError) as e:
                last=e;delay=2**attempt
            if attempt<2:
                self.progress(message=f'Mapterhorn request failed; retry {attempt+1}/2…')
                if self.stop.wait(delay):raise ValueError('Elevation fetch cancelled.')
        raise ValueError(f'Mapterhorn could not be reached after 3 attempts: {last}. Import a GeoTIFF as a fallback.')

    def json(self,url):
        return json.loads(self.get(url,validate=lambda data:json.loads(data)))


def decode(data,expected_size=None):
    with MemoryFile(data) as mem:
        with mem.open() as ds:
            if ds.count<3 or ds.width!=ds.height or not 1<=ds.width<=2048:
                raise ValueError('Invalid Mapterhorn RGB tile; import a GeoTIFF instead.')
            if expected_size and ds.width!=expected_size:
                raise ValueError('Mapterhorn tile size changed unexpectedly. Clear the local cache and retry.')
            rgb=ds.read([1,2,3]).astype('float32')
            z=rgb[0]*256+rgb[1]+rgb[2]/256-32768
            z[ds.dataset_mask()==0]=np.nan
            # Minimum Terrarium code is outside terrestrial/bathymetric elevation; treat as missing, never as a cliff.
            z[z==-32768]=np.nan
            return z


def metadata(client,bounds=None):
    raw=client.json(TILEJSON)
    if not isinstance(raw,dict):raise ValueError('Invalid Mapterhorn TileJSON.')
    templates=raw.get('tiles')
    if not templates or not isinstance(templates,list):raise ValueError('Mapterhorn TileJSON has no tile URL.')
    template=templates[0]
    if not all(k in template for k in ('{z}','{x}','{y}')):raise ValueError('Unsupported Mapterhorn tile URL template.')
    lo=raw.get('minzoom',0);hi=raw.get('maxzoom');zoom_metadata=None
    if hi is None:
        # The live TileJSON currently omits min/max zoom. Use its published archive catalogue,
        # not an assumed global native resolution or a hard-coded provider zoom ceiling.
        listing=client.json(DOWNLOADS)
        items=listing.get('items',[]) if isinstance(listing,dict) else []
        candidates=[]
        for item in items:
            if not isinstance(item,dict):continue
            if item.get('name')=='planet.pmtiles':candidates.append(item);continue
            if bounds and all(k in item for k in ('min_lon','min_lat','max_lon','max_lat')):
                if item['min_lon']<=bounds[0] and item['min_lat']<=bounds[1] and item['max_lon']>=bounds[2] and item['max_lat']>=bounds[3]:candidates.append(item)
        maxima=[i.get('maxzoom',i.get('max_zoom')) for i in candidates]
        maxima=[v for v in maxima if isinstance(v,(int,float))]
        if maxima:hi=max(maxima)
        zoom_metadata=dict(url=DOWNLOADS,archives=candidates)
    if not isinstance(lo,(int,float)) or not isinstance(hi,(int,float)) or not 0<=lo<=hi<=24:raise ValueError('Mapterhorn metadata has no valid zoom range; review its archive metadata or import a GeoTIFF.')
    if raw.get('scheme','xyz') not in ('xyz','tms'):raise ValueError('Unsupported Mapterhorn tile scheme.')
    if raw.get('encoding','terrarium').lower()!='terrarium':raise ValueError('Mapterhorn metadata does not describe Terrarium tiles.')
    b=raw.get('bounds',[-180,-85.05112878,180,85.05112878])
    if not isinstance(b,list) or len(b)!=4 or not all(isinstance(v,(int,float)) for v in b):raise ValueError('Invalid Mapterhorn coverage bounds.')
    return raw,template,int(lo),int(hi),b,zoom_metadata


def tile_coordinate(lon,lat,zoom):
    n=2**zoom
    return ((lon+180)/360*n,(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n)

def tile_range(b,zoom,size):
    # Include only tiles intersecting the sampled rectangle and its one-pixel bilinear halo.
    x0,y0=tile_coordinate(b[0],b[3],zoom);x1,y1=tile_coordinate(b[2],b[1],zoom)
    n=2**zoom;halo=1/size
    return (max(0,math.floor(x0-halo)),max(0,math.floor(y0-halo)),min(n-1,math.floor(x1+halo)),min(n-1,math.floor(y1+halo)))

def tile_url(template,zoom,x,y,scheme):
    return template.replace('{z}',str(zoom)).replace('{x}',str(x)).replace('{y}',str(2**zoom-1-y if scheme=='tms' else y))


def sample_online(bounds,nx,ny,ground_spacing,progress=lambda **v:None,client=None):
    client=client or Client(progress=progress)
    progress(progress=1,message='Reading Mapterhorn TileJSON and source credits…')
    raw,template,lo,hi,coverage,zoom_metadata=metadata(client,bounds)
    if bounds[0]<coverage[0] or bounds[1]<coverage[1] or bounds[2]>coverage[2] or bounds[3]>coverage[3]:
        raise ValueError('Selection is outside Mapterhorn’s published coverage. Import a GeoTIFF.')
    target=layout(bounds,nx,ny)
    if max(target['width'],target['length'])>200000:
        raise ValueError('For reliable local scale and bounded downloads, select an area smaller than 200 km on each side, or import a local GeoTIFF.')
    # Projected rectangular output has slightly curved geographic edges. Request its true footprint.
    actual=transform_bounds(target['crs'],'EPSG:4326',*target['bounds'],densify_pts=41)
    if actual[0]<coverage[0] or actual[1]<coverage[1] or actual[2]>coverage[2] or actual[3]>coverage[3]:
        raise ValueError('The projected model footprint extends outside Mapterhorn coverage. Shrink the selection or import a GeoTIFF.')
    size=raw.get('tileSize',raw.get('tile_size'))
    scheme=raw.get('scheme','xyz')
    if size is None:
        # TileJSON does not require tileSize. Inspect an actual intersecting tile, never assume 256/512.
        tx,ty=tile_coordinate((bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2,lo)
        data=client.get(tile_url(template,lo,int(tx),int(ty),scheme),ttl=30*86400,validate=decode)
        size=decode(data).shape[0]
    if not isinstance(size,int) or not 1<=size<=2048:raise ValueError('Invalid tile size in Mapterhorn metadata.')
    lat=(bounds[1]+bounds[3])/2
    zoom=max(lo,min(hi,math.ceil(math.log2(WORLD*math.cos(math.radians(lat))/(size*ground_spacing)))))
    desired_zoom=zoom
    while True:
        x0,y0,x1,y1=tile_range(actual,zoom,size)
        count=(x1-x0+1)*(y1-y0+1)
        if count<=MAX_TILES:break
        if zoom==lo:raise ValueError('Selection requires too many elevation tiles. Choose a smaller area or import a GeoTIFF.')
        zoom-=1
    catalogue=None;catalogue_error=None
    try:catalogue=client.json(CATALOGUE)
    except Exception as e:catalogue_error=str(e)
    # Catalogue entries do not establish which dataset contributed to a particular pixel.
    # Keep the published catalogue as references, without guessing source or licence from zoom/country.
    credits=dict(provider='Mapterhorn',tilejsonUrl=TILEJSON,attribution=plain(raw.get('attribution')) or 'Mapterhorn — see published attribution',attributionUrl=ATTRIBUTION,
        sourceCatalogueUrl=CATALOGUE,sourceCatalogue=catalogue,catalogueError=catalogue_error,
        underlyingSource='Unknown for this area — review the published source catalogue',nativeResolutionMetres=None,
        license='Unknown for this area — needs review; no commercial-use permission inferred',verticalDatum='Unknown — needs review',
        tilejson=raw,zoomMetadata=zoom_metadata,coverageBounds=coverage,tileZoom=zoom,tileSize=size,tileCount=count,
        zoomLimitedByRequestBudget=zoom<desired_zoom,tileGroundSamplingMetresApprox=WORLD/2**zoom/size*math.cos(math.radians(lat)),
        fetchedAt=datetime.now(timezone.utc).isoformat(),projection=target['crs'].to_string(),projectedBounds=list(target['bounds']),
        outputGrid=dict(columns=nx,rows=ny,spacingMetres=list(target['spacing'])),
        notes='Tile sampling is not native dataset resolution. Catalogue lists possible sources, not exact per-pixel provenance. Local transverse Mercator rectangle encloses the selected geographic area; edges can differ slightly.')
    pixel=WORLD/(2**zoom*size)
    mosaic=np.full(((y1-y0+1)*size,(x1-x0+1)*size),np.nan,dtype='float32')
    needed=[(x,y) for y in range(y0,y1+1) for x in range(x0,x1+1)]
    def load(tile):
        x,y=tile
        data=client.get(tile_url(template,zoom,x,y,scheme),ttl=30*86400,validate=lambda data:decode(data,size))
        return x,y,decode(data,size)
    pool=concurrent.futures.ThreadPoolExecutor(max_workers=4)
    futures=[pool.submit(load,tile) for tile in needed]
    try:
        for done,f in enumerate(concurrent.futures.as_completed(futures),1):
            x,y,z=f.result();mosaic[(y-y0)*size:(y-y0+1)*size,(x-x0)*size:(x-x0+1)*size]=z
            progress(progress=3+15*done/count,message=f'Mapterhorn elevation: {done}/{count} tiles ready (including cache)')
    except BaseException:
        client.stop.set()
        for f in futures:f.cancel()
        raise
    finally:pool.shutdown(wait=True)
    out=np.full((ny,nx),np.nan,dtype='float32')
    reproject(mosaic,out,src_transform=from_origin(-WORLD/2+x0*size*pixel,WORLD/2-y0*size*pixel,pixel,pixel),src_crs='EPSG:3857',src_nodata=np.nan,
        dst_transform=target['transform'],dst_crs=target['crs'],dst_nodata=np.nan,resampling=Resampling.bilinear)
    # GDAL can interpolate across invalid pixels; independently require full bilinear support.
    valid=np.isfinite(mosaic).astype('float32');support=np.zeros((ny,nx),dtype='float32')
    reproject(valid,support,src_transform=from_origin(-WORLD/2+x0*size*pixel,WORLD/2-y0*size*pixel,pixel,pixel),src_crs='EPSG:3857',dst_transform=target['transform'],dst_crs=target['crs'],resampling=Resampling.bilinear)
    if not np.isfinite(out).all() or (support<.9999).any():
        raise ValueError('Mapterhorn has missing elevation data in the selection. Choose a smaller area or import a GeoTIFF; gaps are not filled.')
    return out,credits
