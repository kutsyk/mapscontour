import json,pathlib,sys,tempfile,unittest,sqlite3
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'worker'))
from laser_large import ingest,export,json_items

class LargeLaserTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name)
        self.settings=dict(width=200,margin=2,layers=[dict(id='buildings',name='Buildings',enabled=True,operation='cut',color='#ff0000',stroke=.1)])
    def source(self,elements):
        p=self.root/'input.json';p.write_text(json.dumps({'elements':elements}));db=str(self.root/'source.sqlite')
        meta=ingest(str(p),db,dict(source='test fixture'));return db,meta
    def building(self,ident,x=0):
        return dict(type='way',id=ident,tags={'building':'yes'},geometry=[{'lon':x+.001,'lat':.001},{'lon':x+.003,'lat':.001},{'lon':x+.003,'lat':.003},{'lon':x+.001,'lat':.001}])
    def test_import_index_crop_and_layer_outputs(self):
        db,meta=self.source([self.building(1),self.building(2,1)])
        self.assertEqual(meta['featureCount'],2)
        result=export(db,str(self.root/'out'),[0,0,.01,.01],self.settings)
        self.assertEqual(result['pathCount'],1)
        self.assertIn('layer-buildings.svg',result['files'])
        self.assertFalse(result['credits']['exportSimplified'])
        self.assertIn('width="200mm"',(self.root/'out'/'map.svg').read_text())
    def test_remark_after_elements_cannot_publish_partial_index(self):
        p=self.root/'bad.json';p.write_text(json.dumps({'elements':[self.building(1)],'remark':'runtime timeout'}));db=str(self.root/'bad.sqlite')
        with self.assertRaisesRegex(ValueError,'Incomplete Overpass'):ingest(str(p),db,{})
        self.assertFalse(pathlib.Path(db).exists())
    def test_relation_holes_and_member_deduplication(self):
        p=lambda x,y:dict(lon=x,lat=y)
        outer=[p(.001,.001),p(.009,.001),p(.009,.009),p(.001,.009),p(.001,.001)]
        inner=[p(.003,.003),p(.006,.003),p(.006,.006),p(.003,.003)]
        relation=dict(type='relation',id=5,tags={'type':'multipolygon','building':'yes'},members=[dict(type='way',ref=1,role='outer',geometry=outer[:3]),dict(type='way',ref=2,role='outer',geometry=outer[2:][::-1]),dict(type='way',ref=3,role='inner',geometry=inner)])
        db,_=self.source([dict(type='way',id=1,tags={'building':'yes'},geometry=outer),relation])
        result=export(db,str(self.root/'out'),[0,0,.01,.01],self.settings)
        self.assertEqual(result['pathCount'],1)
        self.assertEqual((self.root/'out'/'map.svg').read_text().count('Z'),2)
    def test_geojson_feature_collection_keeps_holes(self):
        p=self.root/'map.geojson';p.write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','id':10,'properties':{'building':'yes'},'geometry':{'type':'Polygon','coordinates':[[[.001,.001],[.009,.001],[.009,.009],[.001,.001]],[[.004,.003],[.006,.003],[.006,.004],[.004,.003]]]}}]}))
        db=str(self.root/'geo.sqlite');ingest(str(p),db,{})
        result=export(db,str(self.root/'out'),[0,0,.01,.01],self.settings)
        self.assertEqual(result['pathCount'],1)
    def test_osm_node_locations_and_area_assembly(self):
        import osmium
        p=self.root/'fixture.osm';p.write_text('''<osm version="0.6"><node id="1" lat="0.001" lon="0.001"/><node id="2" lat="0.001" lon="0.003"/><node id="3" lat="0.003" lon="0.003"/><way id="20"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/><tag k="building" v="yes"/></way></osm>''')
        binary=self.root/'fixture.osm.pbf'
        with osmium.SimpleWriter(str(binary)) as writer:
            for item in osmium.FileProcessor(str(p)):writer.add(item)
        db=str(self.root/'pbf.sqlite');meta=ingest(str(binary),db,{})
        self.assertEqual(meta['featureCount'],1)
        self.assertFalse(pathlib.Path(db+'.locations').exists())
        self.assertEqual(export(db,str(self.root/'out'),[0,0,.01,.01],self.settings)['pathCount'],1)

if __name__=='__main__':unittest.main()
