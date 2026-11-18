"""Disk-backed OSM ingestion and streaming laser SVG export; never loads a whole dataset."""
import sys,json,math,sqlite3,pathlib,hashlib,time,os,re
from collections import Counter,defaultdict
from datetime import datetime,timezone
from xml.sax.saxutils import escape
import ijson
import numpy as np
from ijson.common import ObjectBuilder
from shapely.geometry import Polygon,LineString,MultiPolygon,shape,box
from shapely.ops import unary_union,transform
from shapely import normalize,get_num_coordinates

LAYERS=('majorRoads','minorRoads','buildings','water','waterLines','parks','airports','railways')
R=6378137.0

def emit(**v):print(json.dumps(v),flush=True)
def now():return datetime.now(timezone.utc).isoformat()
def matches(tags,layer):
    h=tags.get('highway','');w=tags.get('waterway','')
    return {
        'majorRoads':h in ('motorway','trunk','primary'),
        'minorRoads':h in ('secondary','tertiary','residential','unclassified','service','living_street'),
        'buildings':bool(tags.get('building')) and tags['building']!='no',
        'water':tags.get('natural')=='water' or w=='riverbank',
        'waterLines':w in ('river','stream','canal'),
        'parks':tags.get('leisure')=='park' or tags.get('landuse') in ('grass','recreation_ground'),
        'airports':tags.get('aeroway') in ('runway','taxiway','apron','terminal','hangar','helipad'),
        'railways':tags.get('railway')=='rail'
    }.get(layer,False)

def json_items(filename,meta):
    """Parse one feature at a time, including remarks that can follow the elements array."""
    builder=None;depth=0;found=False
    with open(filename,'rb') as f:
        for prefix,event,value in ijson.parse(f,use_float=True):
            if prefix in ('elements','features') and event=='start_array':found=True
            if prefix=='remark' and event=='string':raise ValueError('Incomplete Overpass response: '+value)
            if prefix=='osm3s.timestamp_osm_base' and event=='string':meta['dataTimestamp']=value
            if prefix in ('elements.item','features.item') and event=='start_map':builder=ObjectBuilder();depth=0
            if builder is not None:
                builder.event(event,value)
                if event in ('start_map','start_array'):depth+=1
                elif event in ('end_map','end_array'):depth-=1
                if depth==0:
                    record=builder.value;builder=None
                    yield record,f.tell()
        if not found:raise ValueError('Use an Overpass JSON response with geometry, an OSM GeoJSON FeatureCollection, or an .osm.pbf extract.')

def as_element(record,sequence):
    if record.get('type')!='Feature':return record
    props=record.get('properties') or {};tags=props.get('tags',props)
    geometry=record.get('geometry') or {};kind=geometry.get('type');coords=geometry.get('coordinates')
    ident=record.get('id',sequence)
    try:ident=int(str(ident).split('/')[-1])
    except (ValueError,TypeError):ident=-sequence
    if kind=='LineString':return dict(type='way',id=ident,tags=tags,geometry=[dict(lon=p[0],lat=p[1]) for p in coords])
    if kind in ('Polygon','MultiPolygon'):
        return dict(type='relation',id=ident,tags={**tags,'type':'multipolygon'},geojson=geometry)
    if kind=='MultiLineString':
        return dict(type='way',id=ident,tags=tags,geojson=geometry)
    return dict(type='node',id=ident)

def coordinates(record):
    if record.get('geojson'):
        def flatten(v):
            if len(v)>=2 and isinstance(v[0],(int,float)):yield float(v[0]),float(v[1])
            else:
                for part in v:yield from flatten(part)
        yield from flatten(record['geojson']['coordinates'])
    for p in record.get('geometry',[]):yield float(p['lon']),float(p['lat'])
    for member in record.get('members',[]):
        for p in member.get('geometry',[]):yield float(p['lon']),float(p['lat'])

def connect(filename):
    db=sqlite3.connect(filename);db.execute('PRAGMA cache_size=-32768');db.execute('PRAGMA temp_store=FILE');return db

def ingest(filename,database,source,notify=emit):
    temp=database+'.partial';pathlib.Path(temp).unlink(missing_ok=True)
    db=connect(temp)
    db.executescript('''CREATE TABLE elements(rowid INTEGER PRIMARY KEY,type TEXT,id INTEGER,data TEXT,UNIQUE(type,id));
    CREATE VIRTUAL TABLE spatial USING rtree(rowid,minx,maxx,miny,maxy);
    CREATE TABLE layers(rowid INTEGER,layer TEXT,PRIMARY KEY(rowid,layer));
    CREATE INDEX layer_lookup ON layers(layer,rowid);
    CREATE TABLE metadata(data TEXT);CREATE TABLE relation_members(relation_id INTEGER,way_id INTEGER);
    CREATE INDEX relation_lookup ON relation_members(relation_id);''')
    meta={**source,'indexedAt':now(),'counts':{},'invalidRecords':0};counts=Counter();bounds=[180,90,-180,-90];processed=0;last=time.monotonic()
    size=max(1,os.path.getsize(filename))
    def add(record,position=0):
        nonlocal processed,last
        processed+=1
        try:
            e=as_element(record,processed);tags=e.get('tags') or {};selected=[l for l in LAYERS if matches(tags,l)]
            if selected and e.get('type') in ('way','relation'):
                lowx,lowy,highx,highy=180,90,-180,-90;points=0
                for lon,lat in coordinates(e):
                    if not math.isfinite(lon+lat) or abs(lat)>90 or abs(lon)>180:raise ValueError('invalid coordinate')
                    lowx=min(lowx,lon);lowy=min(lowy,lat);highx=max(highx,lon);highy=max(highy,lat);points+=1
                if points<2:raise ValueError('missing geometry')
                cursor=db.execute('INSERT OR IGNORE INTO elements(type,id,data) VALUES(?,?,?)',(e['type'],int(e['id']),json.dumps(e,separators=(',',':'))))
                if cursor.rowcount:
                    rowid=cursor.lastrowid;db.execute('INSERT INTO spatial VALUES(?,?,?,?,?)',(rowid,lowx,highx,lowy,highy))
                    for layer in selected:db.execute('INSERT INTO layers VALUES(?,?)',(rowid,layer));counts[layer]+=1
                    bounds[0]=min(bounds[0],lowx);bounds[1]=min(bounds[1],lowy);bounds[2]=max(bounds[2],highx);bounds[3]=max(bounds[3],highy)
        except (ValueError,KeyError,TypeError,IndexError):meta['invalidRecords']+=1
        if processed%2000==0:db.commit()
        if time.monotonic()-last>.4:
            notify(progress=5+min(85,position/size*85) if position else 10,message=f'Indexing map: {processed:,} records read, {sum(counts.values()):,} layer memberships')
            last=time.monotonic()
    try:
        if filename.lower().endswith(('.pbf','.osm')):
            import osmium
            # Relation membership is disk-backed and retained for member-way duplicate suppression.
            class Relations(osmium.SimpleHandler):
                def relation(self,r):
                    tags=dict(r.tags)
                    if tags.get('type')=='multipolygon' and any(matches(tags,l) for l in LAYERS):
                        db.executemany('INSERT INTO relation_members VALUES(?,?)',((r.id,m.ref) for m in r.members if m.type=='w'))
            notify(progress=2,message='Reading OSM relation membership…');Relations().apply_file(filename);db.commit()
            factory=osmium.geom.GeoJSONFactory()
            class Handler(osmium.SimpleHandler):
                def way(self,w):
                    tags=dict(w.tags)
                    if not any(matches(tags,l) for l in LAYERS):return
                    try:add(dict(type='way',id=w.id,tags=tags,geometry=[dict(lon=n.lon,lat=n.lat) for n in w.nodes]))
                    except osmium.InvalidLocationError:meta['invalidRecords']+=1
                def area(self,a):
                    if a.from_way():return
                    tags=dict(a.tags)
                    if not any(matches(tags,l) for l in LAYERS):return
                    try:
                        refs=[r[0] for r in db.execute('SELECT way_id FROM relation_members WHERE relation_id=?',(a.orig_id(),))]
                        add(dict(type='relation',id=a.orig_id(),tags={**tags,'type':'multipolygon'},geojson=json.loads(factory.create_multipolygon(a)),memberRefs=refs))
                    except (RuntimeError,ValueError):meta['invalidRecords']+=1
            locations=database+'.locations'
            try:
                notify(progress=5,message='Resolving OSM geometry with a disk-backed node index…')
                Handler().apply_file(filename,locations=True,idx='sparse_file_array,'+locations)
            finally:pathlib.Path(locations).unlink(missing_ok=True)
        else:
            for record,position in json_items(filename,meta):add(record,position)
        count=db.execute('SELECT count(*) FROM elements').fetchone()[0]
        if not count:raise ValueError('No supported OSM features with usable geometry were found. Include geometry (Overpass: out body geom).')
        meta.update(featureCount=count,counts=dict(counts),bounds=bounds,recordsRead=processed)
        db.execute('INSERT INTO metadata VALUES(?)',(json.dumps(meta),));db.commit();db.close();os.replace(temp,database)
        return meta
    except BaseException:db.close();raise

def join_rings(parts):
    pending={i:list(p) for i,p in enumerate(parts)};ends=defaultdict(set)
    for i,p in pending.items():
        if len(p)<2:raise ValueError('incomplete ring')
        ends[tuple(p[0])].add(i);ends[tuple(p[-1])].add(i)
    rings=[]
    def remove(i):
        part=pending.pop(i);ends[tuple(part[0])].discard(i);ends[tuple(part[-1])].discard(i);return part
    while pending:
        ring=remove(next(iter(pending)))
        while ring[-1]!=ring[0]:
            choices=ends[tuple(ring[-1])]
            if len(choices)!=1:raise ValueError('incomplete or ambiguous multipolygon')
            part=remove(next(iter(choices)))
            if part[-1]==ring[-1]:part.reverse()
            ring.extend(part[1:])
        if len(ring)<4:raise ValueError('degenerate ring')
        rings.append(ring)
    return rings

def feature_geometry(e,layer):
    if e.get('geojson'):
        geom=shape(e['geojson']);return geom,geom.geom_type in ('Polygon','MultiPolygon')
    if e['type']=='relation':
        if e.get('tags',{}).get('type')!='multipolygon':raise ValueError('non-multipolygon relation')
        members=[m for m in e.get('members',[]) if m.get('type')=='way']
        outer=join_rings([[(p['lon'],p['lat']) for p in m.get('geometry',[])] for m in members if m.get('role')!='inner'])
        inner=join_rings([[(p['lon'],p['lat']) for p in m.get('geometry',[])] for m in members if m.get('role')=='inner'])
        if not outer:raise ValueError('missing outer rings')
        geom=unary_union([Polygon(r) for r in outer])
        if inner:geom=geom.difference(unary_union([Polygon(r) for r in inner]))
        return geom,True
    points=[(p['lon'],p['lat']) for p in e.get('geometry',[])];closed=len(points)>=4 and points[0]==points[-1]
    area=layer in ('buildings','water','parks') or (layer=='airports' and closed and e.get('tags',{}).get('area')!='no')
    if area and not closed:raise ValueError('unclosed area')
    return (Polygon(points) if area else LineString(points)),area

def layout(bounds,width,margin):
    w,s,e,n=bounds
    if not(-180<=w<e<=180 and -80<=s<n<=80):raise ValueError('Invalid map bounds')
    if not(20<=width<=2000 and 0<=margin<width/2):raise ValueError('Invalid SVG dimensions')
    x=lambda lon:R*lon*math.pi/180;y=lambda lat:R*math.log(math.tan(math.pi/4+lat*math.pi/360))
    scale=(width-2*margin)/(x(e)-x(w));height=2*margin+(y(n)-y(s))*scale
    if height>4000:raise ValueError('SVG is too tall; choose a wider rectangle or smaller physical width')
    def project(lon,lat,z=None):
        # Shapely supplies whole coordinate tuples. Vectorise before multiplying;
        # Python's integer * tuple repeats the tuple instead of scaling coordinates.
        lon=np.asarray(lon,dtype='float64');lat=np.asarray(lat,dtype='float64')
        return margin+(R*lon*np.pi/180-x(w))*scale,margin+(y(n)-R*np.log(np.tan(np.pi/4+lat*np.pi/360)))*scale
    return height,project

def fmt(n):return ('%.4f'%n).rstrip('0').rstrip('.') or '0'
def geometry_path(geom):
    kind=geom.geom_type
    if geom.is_empty:return ''
    def line(points,close=False):return ''.join(('M' if i==0 else 'L')+fmt(p[0])+','+fmt(p[1]) for i,p in enumerate(points))+('Z' if close else '')
    if kind=='Polygon':return line(geom.exterior.coords,True)+''.join(line(r.coords,True) for r in geom.interiors)
    if kind in ('LineString','LinearRing'):return line(geom.coords)
    if hasattr(geom,'geoms'):return ''.join(geometry_path(g) for g in geom.geoms)
    return ''

QUERY='''SELECT e.rowid,e.data FROM elements e JOIN layers l ON l.rowid=e.rowid JOIN spatial s ON s.rowid=e.rowid
WHERE l.layer=? AND s.minx<=? AND s.maxx>=? AND s.miny<=? AND s.maxy>=? ORDER BY e.type,e.rowid'''

def export(database,output,bounds,settings,notify=emit):
    out=pathlib.Path(output);out.mkdir(parents=True,exist_ok=True);db=connect(database)
    source=json.loads(db.execute('SELECT data FROM metadata').fetchone()[0])
    db.executescript('CREATE TEMP TABLE seen(hash BLOB PRIMARY KEY);CREATE TEMP TABLE covered(layer TEXT,id INTEGER,PRIMARY KEY(layer,id));')
    width=float(settings['width']);margin=float(settings['margin']);height,project=layout(bounds,width,margin);frame=box(margin,margin,width-margin,height-margin)
    enabled=[l for l in settings['layers'] if l.get('enabled')]
    if not enabled:raise ValueError('Choose at least one layer')
    args=lambda name:(name,bounds[2],bounds[0],bounds[3],bounds[1])
    total=sum(db.execute('SELECT count(*) FROM ('+QUERY+')',args(l['id'])).fetchone()[0] for l in enabled)
    header=f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(width)}mm" height="{fmt(height)}mm" viewBox="0 0 {fmt(width)} {fmt(height)}"><title>MapsContour laser map</title><desc>'+escape(source.get('attribution','OpenStreetMap contributors')+' — '+source.get('licenseUrl',''))+'</desc>'
    manifest=[];counts={};warnings=Counter();paths=0;processed=0;preview_paths=0;preview_points=0;last=time.monotonic()
    full=open(out/'map.svg.partial','w');preview=open(out/'preview.svg.partial','w');full.write(header);preview.write(header)
    try:
        for layer in enabled:
            name=layer['id'];operation=layer['operation'];color=layer['color'];stroke=float(layer['stroke'])
            if name not in LAYERS or operation not in ('cut','score','engrave') or not re.fullmatch('#[a-fA-F0-9]{6}',color) or not .01<=stroke<=5:raise ValueError('Invalid layer settings')
            layerfile='layer-'+name+'.svg';part=open(out/(layerfile+'.partial'),'w');part.write(header)
            group=f'<g id="{name}" data-operation="{operation}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:groupmode="layer" inkscape:label="{escape(layer["name"]+" · "+operation, {chr(34):"&quot;"})}">'
            full.write(group);part.write(group);preview.write(group);count=0
            try:
                for rowid,raw in db.execute(QUERY,args(name)):
                    e=json.loads(raw);processed+=1
                    if e['type']=='way' and db.execute('SELECT 1 FROM covered WHERE layer=? AND id=?',(name,e['id'])).fetchone():continue
                    try:
                        geom,area=feature_geometry(e,name)
                        if not geom.is_valid:raise ValueError('invalid topology')
                        geom=transform(project,geom).intersection(frame)
                        if geom.is_empty:continue
                        d=geometry_path(geom)
                        if not d:continue
                        digest=hashlib.sha256(operation.encode()+normalize(geom).wkb).digest()
                        if not db.execute('INSERT OR IGNORE INTO seen VALUES(?)',(digest,)).rowcount:
                            warnings['Duplicate paths removed']+=1;continue
                        if e['type']=='relation':
                            refs=e.get('memberRefs',[m['ref'] for m in e.get('members',[]) if m.get('type')=='way'])
                            db.executemany('INSERT OR IGNORE INTO covered VALUES(?,?)',((name,r) for r in refs))
                        actual_color=color;road=e.get('tags',{}).get('highway');overrides=settings.get('roadColors',{})
                        if road:
                            override=overrides.get(road) or (overrides.get('local') if road in ('residential','unclassified','service','living_street') else None)
                            if override and re.fullmatch('#[a-fA-F0-9]{6}',override):actual_color=override
                        filled=area and operation=='engrave'
                        def svg_path(path):return f'<path data-osm="{e["type"]}-{e["id"]}" d="{path}" fill="{actual_color if filled else "none"}" fill-rule="evenodd" stroke="{"none" if filled else actual_color}" stroke-width="{fmt(stroke)}" stroke-linejoin="round" stroke-linecap="round"/>'
                        text=svg_path(d);full.write(text);part.write(text);count+=1;paths+=1
                        pick=int.from_bytes(hashlib.sha256(f'{name}:{e["type"]}:{e["id"]}'.encode()).digest()[:4],'big')/2**32
                        if preview_paths<3000 and pick<min(1,3000/max(1,total)):
                            simple=geom.simplify(.05,preserve_topology=True);points=get_num_coordinates(simple)
                            if preview_points+points<=150000:
                                preview.write(svg_path(geometry_path(simple)));preview_points+=points;preview_paths+=1
                    except (ValueError,KeyError,TypeError,RuntimeError) as error:warnings['Incomplete or invalid geometries skipped']+=1
                    if time.monotonic()-last>.4:
                        db.commit();notify(progress=5+processed/max(1,total)*90,message=f'Writing {name}: {paths:,} paths, {processed:,}/{total:,} candidates processed');last=time.monotonic()
                counts[name]=count
                part.write('</g></svg>');part.close();os.replace(out/(layerfile+'.partial'),out/layerfile);manifest.append(layerfile)
                full.write('</g>');preview.write('</g>')
            finally:
                if not part.closed:part.close()
        if settings.get('frame'):
            rect=f'<g id="frame" data-operation="cut"><rect width="{fmt(width)}" height="{fmt(height)}" fill="none" stroke="#ff0000" stroke-width="0.1"/></g>';full.write(rect);preview.write(rect);paths+=1
        notes=[f'{k}: {v}' for k,v in warnings.items()]
        if not paths:notes.append('No features intersect this selection. Check the local source coverage and selected layers.')
        if source.get('invalidRecords'):notes.append(f'Source records lacking valid geometry during import: {source["invalidRecords"]}')
        credits={**source,'feature':'laser-map','bounds':bounds,'settings':settings,'widthMm':width,'heightMm':height,'pathCount':paths,'counts':counts,'warnings':notes,'exportedAt':now(),'previewPathCount':preview_paths,'previewSimplified':preview_paths<paths,'previewToleranceMm':.05,'exportSimplified':False,'projection':'Web Mercator uniformly scaled to SVG millimetres; local ground scale approximate','manufacturing':'Roads are centerlines. No kerf compensation or connectivity guarantees.'}
        full.write('<metadata>'+escape(json.dumps(credits))+'</metadata></svg>');preview.write('</svg>');full.close();preview.close()
        os.replace(out/'map.svg.partial',out/'map.svg');os.replace(out/'preview.svg.partial',out/'preview.svg')
        (out/'settings-credits.json').write_text(json.dumps(credits,indent=2))
        files=['map.svg','preview.svg','settings-credits.json']+manifest
        (out/'manifest.json').write_text(json.dumps(files))
        return dict(files=files,credits=credits,width=width,height=height,pathCount=paths,counts=counts,warnings=notes,bytes=(out/'map.svg').stat().st_size,previewSimplified=credits['previewSimplified'])
    finally:
        full.close();preview.close();db.close()

def run(req):
    if req['action']=='import':
        meta=ingest(req['path'],req['database'],req['source']);pathlib.Path(req['metadata']).write_text(json.dumps(meta));emit(result=meta)
    else:
        if not pathlib.Path(req['database']).exists():ingest(req['path'],req['database'],req['source'],notify=lambda **v:emit(**{**v,'progress':v.get('progress',0)*.4}))
        emit(result=export(req['database'],req['output'],req['bounds'],req['settings'],notify=lambda **v:emit(**{**v,'progress':40+v.get('progress',0)*.6})))
if __name__=='__main__':
    try:run(json.load(sys.stdin))
    except Exception as error:emit(error=str(error));sys.exit(1)
