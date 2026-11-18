"""Optional disk-backed regression: larger than the old byte, feature and point limits."""
import json,pathlib,sys,tempfile,time,resource
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'worker'))
from laser_large import ingest,export
count=70000
with tempfile.TemporaryDirectory() as folder:
    root=pathlib.Path(folder);source=root/'large.json'
    started=time.monotonic()
    with source.open('w') as f:
        f.write('{"elements":[')
        for i in range(count):
            x=.001+(i%350)*.0001;y=.001+(i//350)*.0001
            coordinates=[(x,y),(x+.00002,y),(x+.00004,y),(x+.00004,y+.00002),(x+.00004,y+.00004),(x+.00002,y+.00004),(x,y+.00004),(x,y)]
            feature=dict(type='way',id=i+1,tags={'building':'yes','description':'benchmark fixture '*40},geometry=[dict(lon=a,lat=b) for a,b in coordinates])
            if i:f.write(',')
            json.dump(feature,f)
        f.write(']}')
    assert source.stat().st_size>32*1024*1024
    database=str(root/'source.sqlite')
    meta=ingest(str(source),database,{'source':'Synthetic large-map benchmark'},notify=lambda **v:None)
    settings=dict(width=1000,margin=2,layers=[dict(id='buildings',name='Buildings',enabled=True,operation='cut',color='#ff0000',stroke=.1)])
    result=export(database,str(root/'out'),[0,0,.04,.03],settings,notify=lambda **v:None)
    assert meta['featureCount']==count
    assert result['pathCount']==count,(result['pathCount'],result['warnings'])
    assert result['credits']['previewPathCount']<=3000
    assert result['credits']['exportSimplified'] is False
    full=root/'out'/'map.svg';layer=root/'out'/'layer-buildings.svg'
    def paths(filename):
        # Do not load the full SVG to verify it.
        found=0;tail=''
        with filename.open() as f:
            while True:
                chunk=f.read(65536)
                if not chunk:break
                text=tail+chunk;found+=text.count('<path ');tail=text[-5:]
        return found
    assert paths(full)==count;assert paths(layer)==count
    print(json.dumps(dict(features=count,geometryPoints=count*8,inputMB=round(source.stat().st_size/1e6,1),svgMB=round(full.stat().st_size/1e6,1),previewPaths=result['credits']['previewPathCount'],previewKB=round((root/'out'/'preview.svg').stat().st_size/1024),seconds=round(time.monotonic()-started,1),peakRSS=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)))
