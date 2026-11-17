import sys, unittest, tempfile, pathlib, json, struct
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'worker'))
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from main import mesh_grid, run
from providers import sample, metadata

class TerrainTests(unittest.TestCase):
    def test_closed_solids(self):
        for z in [np.ones((3,4))*3,np.array([[3.,5.,9.],[4.,6.,7.],[3.,8.,4.]])]:
            m=mesh_grid(z,100,60)
            self.assertTrue(m.is_watertight)
            self.assertTrue(m.is_winding_consistent)
            self.assertGreater(m.volume,0)
            blob=m.export(file_type='stl')
            self.assertEqual(len(blob),84+50*len(m.faces))
    def test_adjacent_tiles_match(self):
        z=sample(None,[-121.98,46.8,-121.67,47],11,9)
        self.assertTrue(np.array_equal(z[:,:6][:,-1],z[:,5:][:,0]))
        for tile in [z[:,:6],z[:,5:]]:
            self.assertTrue(mesh_grid(tile,100,90).is_watertight)
    def test_geotiff_coverage_and_nodata(self):
        with tempfile.TemporaryDirectory() as d:
            p=str(pathlib.Path(d)/'dem.tif')
            data=np.full((100,100),500,dtype='float32');data[45:55,45:55]=-9999
            with rasterio.open(p,'w',driver='GTiff',width=100,height=100,count=1,dtype='float32',crs='EPSG:4326',transform=from_bounds(-1,-1,1,1,100,100),nodata=-9999) as ds:ds.write(data,1)
            self.assertGreater(metadata(p)['resolution'],0)
            self.assertTrue(np.isfinite(sample(p,[-.9,-.9,-.5,-.5],10,10)).all())
            with self.assertRaisesRegex(ValueError,'outside'):sample(p,[-2,-1,1,1],10,10)
            with self.assertRaisesRegex(ValueError,'Insufficient'):sample(p,[-.3,-.3,.3,.3],50,50)
    def test_stl_export_keeps_full_grid_above_preview_triangle_cap(self):
        nx,ny=401,301
        elevations=np.linspace(100,1100,nx*ny).reshape(ny,nx)
        with tempfile.TemporaryDirectory() as d:
            request=dict(action='generate',bounds=[-121.98,46.8,-121.67,47],nx=nx,ny=ny,
                width=200,base=3,relief=2,across=1,down=1,output=d,source='test full-resolution DEM')
            with patch('main.sample',return_value=elevations) as sampler,patch('main.emit'):
                run(request)
            self.assertEqual(sampler.call_args.args[2:],(nx,ny))
            binary=pathlib.Path(d,'terrain-1-1.stl').read_bytes()
            triangles=struct.unpack_from('<I',binary,80)[0]
            expected=2*(nx-1)*(ny-1)+6*((nx-1)+(ny-1))
            self.assertEqual(triangles,expected)
            self.assertGreater(triangles,200000)
            self.assertEqual(len(binary),84+50*triangles)
            credit=json.loads(pathlib.Path(d,'settings-credits.json').read_text())
            self.assertEqual((credit['nx'],credit['ny']),(nx,ny))

    def test_sample_extent(self):
        with self.assertRaisesRegex(ValueError,'outside'):sample(None,[0,0,1,1],10,10)

if __name__=='__main__': unittest.main()
