import io
import json
import pathlib
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
import warnings
import numpy as np
import rasterio
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'worker'))
from mapterhorn import Client, decode, sample_online, TILEJSON, CATALOGUE, WORLD, DOWNLOADS, TileMissing
from rasterio.warp import transform
from grid import layout
import main

warnings.filterwarnings('ignore',category=NotGeoreferencedWarning)

def webp(elevations):
    z=np.asarray(elevations,dtype='float64')+32768
    rgb=np.stack([np.floor(z/256),np.floor(z)%256,np.round((z-np.floor(z))*256)]).astype('uint8')
    with MemoryFile() as mem:
        with mem.open(driver='WEBP',width=z.shape[1],height=z.shape[0],count=3,dtype='uint8',LOSSLESS='YES') as ds:ds.write(rgb)
        return mem.read()

class Response(io.BytesIO):
    def __init__(self,data,url):super().__init__(data);self.url=url
    def geturl(self):return self.url

class MapterhornTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.raw={'tiles':['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],'minzoom':8,'maxzoom':8,'tileSize':16,'bounds':[-180,-80,180,80],'attribution':'<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>'}
        self.calls=[];self.image=webp(np.full((16,16),123.5));self.catalogue=[{'name':'Published reference only','source':'fixture','license':'Fixture licence'}]
    def opener(self,req,timeout):
        self.calls.append(req.full_url)
        data=json.dumps(self.raw).encode() if req.full_url==TILEJSON else json.dumps(self.catalogue).encode() if req.full_url==CATALOGUE else self.image
        return Response(data,req.full_url)
    def client(self):return Client(self.temp.name,opener=self.opener)
    def test_terrarium_negative_zero_fractional_and_high_elevations(self):
        z=np.tile(np.array([-430.25,0.,100.5,8848.125]),(4,1))
        np.testing.assert_array_equal(decode(webp(z)),z)
    def test_tile_seam_and_cache_and_unknown_source(self):
        # Cross the x=128 and y=128 boundaries at z8. Four required neighbours, no worldwide fetch.
        events=[];b=[-.02,-.02,.02,.02]
        z,credit=sample_online(b,20,20,500,client=self.client(),progress=lambda **v:events.append(v))
        np.testing.assert_allclose(z,123.5,atol=.001)
        self.assertIsNone(credit['nativeResolutionMetres'])
        self.assertIn('Unknown',credit['underlyingSource']);self.assertIn('Unknown',credit['license'])
        self.assertEqual(credit['sourceCatalogue'],self.catalogue)
        self.assertEqual(len([u for u in self.calls if u.endswith('.webp')]),4)
        before=len(self.calls);sample_online(b,20,20,500,client=self.client())
        self.assertEqual(len(self.calls),before)
        self.assertGreater(len(events),1)
        self.assertEqual(credit['attribution'],'© Mapterhorn')
    def test_reprojection_places_sloping_tiles_correctly_across_seams(self):
        def opener(req,timeout):
            if not req.full_url.endswith('.webp'):return self.opener(req,timeout)
            parts=req.full_url.split('/')
            x=int(parts[-2]);y=int(parts[-1].split('.')[0])
            xx,yy=np.meshgrid(np.arange(16)+x*16,np.arange(16)+y*16)
            z=1000+(xx-2048)*4+(yy-2048)*2
            return Response(webp(z),req.full_url)
        bounds=[-.02,-.02,.02,.02];nx=20;ny=20
        z,_=sample_online(bounds,nx,ny,500,client=Client(self.temp.name,opener=opener))
        target=layout(bounds,nx,ny)
        xx,yy=np.meshgrid(np.linspace(target['bounds'][0],target['bounds'][2],nx),np.linspace(target['bounds'][3],target['bounds'][1],ny))
        mx,my=transform(target['crs'],'EPSG:3857',xx.ravel().tolist(),yy.ravel().tolist())
        px=WORLD/(256*16)
        cols=(np.array(mx)+WORLD/2)/px-.5;rows=(WORLD/2-np.array(my))/px-.5
        expected=(1000+(cols-2048)*4+(rows-2048)*2).reshape(ny,nx)
        np.testing.assert_allclose(z,expected,atol=.01)

    def test_live_tilejson_shape_uses_published_archive_zoom_limits(self):
        del self.raw['minzoom'];del self.raw['maxzoom']
        archives={'items':[{'name':'planet.pmtiles','min_zoom':0,'max_zoom':8},
            {'name':'6-region.pmtiles','min_lon':-1,'min_lat':-1,'max_lon':1,'max_lat':1,'min_zoom':9,'max_zoom':10}]}
        def opener(req,timeout):
            if req.full_url==DOWNLOADS:return Response(json.dumps(archives).encode(),req.full_url)
            return self.opener(req,timeout)
        _,credits=sample_online([-.02,-.02,.02,.02],10,10,500,client=Client(self.temp.name,opener=opener))
        self.assertEqual(credits['zoomMetadata']['url'],DOWNLOADS)
        self.assertEqual(len(credits['zoomMetadata']['archives']),2)
        self.assertLessEqual(credits['tileZoom'],10)

    def test_size_discovery_when_tilejson_omits_tile_size(self):
        del self.raw['tileSize']
        _,credit=sample_online([-.02,-.02,.02,.02],10,10,500,client=self.client())
        self.assertEqual(credit['tileSize'],16)
    def test_metric_grid_has_equal_physical_spacing_at_high_latitude(self):
        target=layout([10,69.98,10.04,70.02],25,70)
        self.assertLess(target['width'],target['length'])
        # Longitude width is around 1527m at 70N; latitude height around 4462m.
        self.assertAlmostEqual(target['width'],1528,delta=5)
        self.assertAlmostEqual(target['length'],4463,delta=5)
        self.assertAlmostEqual(target['transform'].a,target['width']/24)
        self.assertAlmostEqual(-target['transform'].e,target['length']/69)
    def test_missing_tile_and_invalid_pixels_are_not_filled(self):
        client=self.client()
        def missing(req,timeout):
            if req.full_url.endswith('.webp'):raise urllib.error.HTTPError(req.full_url,404,'missing',{},None)
            return self.opener(req,timeout)
        client.opener=missing
        with self.assertRaisesRegex(TileMissing,'GeoTIFF'):sample_online([-.02,-.02,.02,.02],10,10,500,client=client)
        self.image=webp(np.full((16,16),-32768))
        with self.assertRaisesRegex(ValueError,'missing elevation'):sample_online([-.02,-.02,.02,.02],10,10,500,client=self.client())
    def test_retry_transient_timeout_and_no_retry_for_forbidden(self):
        attempts=[]
        def flaky(req,timeout):
            attempts.append(timeout)
            if len(attempts)<3:raise urllib.error.URLError('timeout')
            return Response(b'ok',req.full_url)
        client=Client(self.temp.name,opener=flaky)
        with patch.object(client.stop,'wait',return_value=False):self.assertEqual(client.get(TILEJSON),b'ok')
        self.assertEqual(attempts,[15,15,15])
        client=Client(self.temp.name+'/other',opener=lambda req,timeout:(_ for _ in ()).throw(urllib.error.HTTPError(req.full_url,403,'forbidden',{},None)))
        with self.assertRaisesRegex(ValueError,'HTTP 403'):client.get(TILEJSON)
    def test_cancellation_stops_before_any_request(self):
        client=self.client();client.stop.set()
        with self.assertRaisesRegex(ValueError,'cancelled'):client.get(TILEJSON)
        self.assertEqual(self.calls,[])
    def test_bad_cached_response_is_replaced(self):
        client=self.client()
        with self.assertRaises(Exception):client.get(TILEJSON,validate=lambda b:decode(b))
        self.assertEqual(list(pathlib.Path(self.temp.name).iterdir()),[])
    def test_catalogue_failure_is_recorded_without_inventing_licence(self):
        def opener(req,timeout):
            if req.full_url==CATALOGUE:raise urllib.error.HTTPError(req.full_url,403,'forbidden',{},None)
            return self.opener(req,timeout)
        z,c=sample_online([-.02,-.02,.02,.02],10,10,500,client=Client(self.temp.name,opener=opener))
        self.assertTrue(np.isfinite(z).all());self.assertIsNone(c['sourceCatalogue']);self.assertIn('403',c['catalogueError']);self.assertIn('Unknown',c['license'])
    def test_existing_export_pipeline_saves_online_credit_snapshot(self):
        req=dict(action='generate',provider='mapterhorn',bounds=[-.02,-.02,.02,.02],nx=5,ny=5,width=100,spacing=1,base=3,relief=2,across=2,down=2,output=self.temp.name,source='Mapterhorn',attribution='Mapterhorn')
        fixture=np.arange(25,dtype='float64').reshape(5,5)
        with patch.object(main,'sample_online',return_value=(fixture,{'provider':'Mapterhorn','license':'Unknown'})),patch.object(main,'emit') as emit:
            main.run(req)
        credit=json.loads(pathlib.Path(self.temp.name,'settings-credits.json').read_text())
        self.assertEqual(credit['sourceMetadata']['license'],'Unknown')
        self.assertEqual(credit['units'],'millimetres')
        self.assertEqual(len(list(pathlib.Path(self.temp.name).glob('*.stl'))),4)
        self.assertEqual(len(emit.call_args_list[-1].kwargs['result']['files']),5)

if __name__=='__main__':unittest.main()
