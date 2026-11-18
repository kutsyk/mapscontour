# MapsContour local terrain workshop

A single-user Area → Size → Make tool. React/TypeScript/Vite and MapLibre provide the workspace, Express runs the loopback-only API, and a Python worker uses Rasterio, NumPy and trimesh to produce closed binary STL files. No accounts, cloud storage or hosted API. Elevation can come from the offline sample, a local GeoTIFF, or explicitly selected Mapterhorn online tiles.

## Setup and launch

Use Node.js 22.12+ (or 20.19+) and Python 3.9+; Python 3.11/3.12 is recommended for readily available geospatial wheels.

```sh
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm start
```

After the one-time setup, **`npm start`** launches both components. Open **http://127.0.0.1:5173**. Express binds only to **127.0.0.1:4311**, and Vite binds only to **127.0.0.1:5173**. Stop with Ctrl-C. Keep these ports available. `MAPSCONTOUR_PYTHON=/absolute/path/to/python npm start` selects another Python environment. Windows users should create their venv normally and set that variable to `.venv/Scripts/python.exe` using their shell's environment-variable syntax.

Start with the generated sample mountain: choose Size, adjust relief, then Make → Generate STL. It is synthetic, freely reusable demonstration terrain near a Washington coordinate extent; **it is not real elevation data**. The entire sample-to-STL workflow works offline after dependencies are installed. WebGL is required for map/3D rendering.

## Using your own DEM

Import a local `.tif` or `.tiff` under Area → Import your own GeoTIFF. Supply source credits/licence text; it will be copied into the generated settings/credits JSON.

Requirements:

- A single elevation band with a valid CRS. Geographic and projected source CRS are reprojected onto the same local metric grid used by online elevation and STL generation.
- Elevation values in **metres**. Convert feet or scaled/offset encoded bands before import. Missing vertical unit metadata is accepted with a warning because many valid DEMs omit it; you must verify the units yourself.
- Use a north-up, georeferenced DEM with an accurate NoData value/mask. Coverage is checked at output grid sample locations. NoData gaps or areas outside the DEM block generation; the app does not invent missing elevations.
- Imports are limited to 2 GiB. Choose a local region rather than a global raster. Antimeridian selections and latitudes beyond ±80° are unsupported.

The selection has a center handle for repositioning, four edge handles and four corner handles for resizing. Drag a handle with a mouse or touch, or focus it and use arrow keys (Shift makes larger changes). The rectangle stays north-up; rotation is not supported. The camera stays still during edits, and elevation refreshes after release. Use Draw a new rectangle and two map clicks to start over, or enter west, south, east, north bounds in decimal degrees. Reset view fits the current selection. The thin muted boundary shows the source extent; the teal dashed boundary shows the selection. Place coordinates use **latitude, longitude**. Searching elsewhere changes the selection. With Mapterhorn selected, elevation for that selection is fetched; with sample/GeoTIFF selected, no online elevation requests occur. If the selection falls outside the active source, use the coverage warning to return to the sample/source extent or import a DEM for the chosen area. Fit my bed uses a custom profile and equal-sized tiles. Tiling is axis-aligned with no connectors, kerf, overlap or machining allowance.

All providers now sample a local WGS84 transverse-Mercator grid centred on the selection, with model nodes at pixel centres and uniform horizontal spacing in metres. Width/length come from this projected grid; the UI uses preliminary approximate dimensions until preview is ready. The projected rectangle encloses the geographic selection, so its edges can extend slightly beyond the map rectangle. Online selections are limited to 200 km on each side to keep scale distortion and downloads bounded; use smaller workshop areas for best results. This is not a surveying tool. GeoTIFF source sampling is estimated from raster extent/dimensions. Mapterhorn native resolution is unknown, independently of tile zoom or delivered pixel spacing. Source vertical datum, accuracy, void fills, vegetation/buildings and licence limitations remain your responsibility.

Relief is vertical exaggeration relative to horizontal map scale: `height_mm = (elevation_m - selected_min_m) × model_width_mm / ground_width_m × relief`. A 2× setting doubles relief but leaves the footprint unchanged. A solid base is added below the selected minimum. Stock fit excludes machining allowance. Preview elevation extrema and stock fit are approximate because the preview uses a 90 × 90 grid; the settings file records the actual final extrema and total thickness. Finer output does not create additional source detail.

## Laser map SVG (second feature)

Choose the **Laser map SVG** tab in the header. It shares the current map rectangle and uses **Area → Layers → Export**. No DEM upload or elevation fetch is required. Terrain settings remain independent and available in the first tab.

1. Frame a local area with the existing center/edge/corner controls, exact bounds or place search.
2. Choose physical width (millimetres or inches), margin, included layers, colors, stroke widths in millimetres, and cut/score/engrave grouping. Length follows the map proportions. Optional subtype colors override the major/minor road color. An outer cut frame is optional.
3. Generate from OpenStreetMap, inspect the exact SVG preview, then download `map.svg` and `settings-credits.json`. **Try a synthetic demo** exercises export without an online map-data request. The preview has zoom and reset controls.

Layers retained from the original map-exporter: major roads, minor roads, buildings, water areas, optional river/stream/canal centerlines, parks/grass, airport infrastructure and railways. SVGs have physical `mm` dimensions and viewBox coordinates in millimetres. Engrave fills closed areas; open features remain centerlines. Named groups, colors and `data-operation` metadata describe intent; configure power/speed and operation interpretation in your laser editor. There is no automatic G-code or machine control.

Geometry is clipped to the actual rectangle, not just hidden by an SVG clipPath. Fragmented/reversed relation members are joined before polygon assembly; inner holes are preserved. Incomplete areas/relations are skipped with counts. Relation-member duplicates and exact/reversed duplicate line paths for the same operation are suppressed. Partial overlapping lines and self-supporting cutout geometry still need manufacturing review.

**Limits:** roads are centerlines, not buffered connected road cutouts. There is no kerf compensation, island/bridge analysis, tab generation, minimum feature-size validation or laser sheet tiling yet. The laser exporter uses uniformly scaled Web Mercator to preserve drawing proportions; ground scale is approximate for these small areas. It is not guaranteed to align exactly to the terrain feature's local metric projection. Review the output in your laser editor before fabrication.

Online OSM features are requested only when Generate is pressed, through the local API to **https://overpass-api.de/api/interpreter**. The selected rectangle and requested layer filters leave this computer; imported DEMs and STL files do not. The public endpoint is best-effort shared infrastructure, with bounded retry and cancellation. Query limits: at most 400 km², 40 km per side, 32 MiB response, 50,000 elements and 500,000 geometry points. Reduce the selection/layers when a limit is exceeded. Overpass errors/partial results are not treated as successful empty exports.

Query results are cached for 24 hours under `data/cache/laser/`, keyed by exact query/bounds/layers, independently of output dimensions and colors. Exports are saved in `data/laser/<id>/`; downloads remain available from disk after restart. Settings are stored independently in browser localStorage. Changed area/style/size marks existing previews and downloads stale until regenerated. Cancellation aborts fetching or terminates SVG worker processing. A local save already in progress may finish even if the browser request is cancelled.

Credits include OSM attribution, ODbL link, requested bounds, physical dimensions, layer/operation settings, available OSM base timestamp, fetch time, counts and geometry warnings. Attribution is embedded in SVG metadata/description and saved as a sidecar; provide the appropriate visible credit on distributed products as required by [OSM attribution guidance](https://www.openstreetmap.org/copyright). The synthetic demo is clearly labeled and is not attributed to OSM.

The original sibling `map-exporter` folder was inspected but not modified. See [the implementation review and prioritized feature roadmap](docs/map-exporter-review.md) for concrete original-code findings, fixes delivered here, and proposed manufacturing improvements.

## 3D preview

The preview uses light matte wood for the relief and darker wood for walls/base, with neutral diffuse lighting and no dynamic shadows. Drag to orbit, scroll/pinch to zoom, and use Reset view or Top view to fit the model. Camera motion never rebuilds geometry. Rendering is on demand and stops after orbit damping settles; pixel density is capped at 1.5× for tablet/GPU responsiveness.

Preview buffers are built in a browser worker, independently of STL geometry. Large input grids are reduced to at most 200,000 terrain-surface triangles using area averages with prominent peak/valley retention. Downsampling remains approximate and can omit features smaller than an output footprint. The current API also supplies a separate 90 × 90 preview grid; finer detail in the final export is not represented by that preview. Width, length, relief and base changes reuse normalised geometry via transforms, debounced by 160 ms. The brief loading indicator appears only for geometry preparation, not camera movement. Replaced buffers and all scene resources are disposed on replacement/unmount.

**STL export is unchanged:** Python fetches/samples its full requested output grid based on model size, grid spacing and tiling. Preview simplification is browser-only and is never used as export input.

## Local files and privacy

- `data/imports/`: local copies of imported DEMs. `data/sources.json`: import catalogue and credits.
- `data/cache/mapterhorn/`: cached TileJSON, source catalogue and WebP elevation tiles. Metadata expires after 24 hours; tiles after 30 days. Atomic writes prevent partial downloads being treated as valid cache entries. Cached bytes are validated before reuse. No automatic cache-size eviction; with the app stopped, delete this directory to clear it.
- `data/jobs/<job-id>/`: binary STL tile files and `settings-credits.json`, including manufacturing settings, actual extrema, attribution, and validation result.
- Browser localStorage stores width, relief, base, stock, and the custom machine profile. These stay on this computer/browser.
- Data is excluded from Git. Nothing uploads imported elevation. Downloads are offered only after every tile passes watertightness, consistent winding and positive-volume checks. STL has no embedded unit declaration: interpret coordinates as **millimetres**, including when the UI uses inches.
- Cancel terminates the Python generation process. Partial files remain in its job directory for inspection but are never offered as finished downloads. There is no automatic deletion. Completed files remain available on disk after restart; the current session's download links are not restored.

The optional **Online map & place search** switch is off by default. Enabling it requests OpenStreetMap raster tiles and sends explicit place searches to Nominatim. It does not retrieve elevation or upload DEMs. Mapterhorn elevation is a separate explicit source choice, independent of the basemap switch. No remote fonts or analytics are used.

## Data-source notes

### Mapterhorn online elevation

Choose **Area → Elevation source → Mapterhorn · online elevation**. Your current selection and model settings stay in place; there is no GeoTIFF upload requirement. Online mode sends selected-area tile coordinates and your network address to Mapterhorn. It also requests TileJSON, the attribution catalogue and, when needed, the archive index. The Express API and all imported/generated files remain on this computer. No API key, account or additional Python package is needed; the Rasterio/GDAL installation must support the **WEBP** driver (the tested Rasterio wheel does).

Published endpoints:

- [TileJSON](https://tiles.mapterhorn.com/tilejson.json)
- [Documented Terrarium WebP access](https://mapterhorn.com/data-access/): `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`
- [Attribution and individual source licences](https://mapterhorn.com/attribution/)
- [Published source catalogue JSON](https://download.mapterhorn.com/attribution.json)
- [Coverage viewer](https://mapterhorn.com/coverage/)

The worker reads the tile template, coverage, scheme, attribution and any available zoom range from TileJSON. The current live TileJSON omits zoom limits: the worker resolves them from the published [archive index](https://download.mapterhorn.com/download_urls.json), using the global archive and any regional archive containing the selection. It downloads only that index metadata, never the PMTiles archives. Both metadata snapshots are retained with credits. If tile size is absent, it inspects a tile intersecting the selection at the advertised minimum zoom, rather than assuming a pixel size. Pixels are decoded **before** interpolation as `(R × 256 + G + B / 256) − 32768` metres. Alpha/masked pixels and the minimum Terrarium code (−32768 m) are treated as missing, not flattened or filled. Needed tiles are mosaicked in EPSG:3857 and bilinearly reprojected to the shared local metric grid. A one-source-pixel interpolation halo can require neighbouring tiles at selection boundaries.

Zoom is chosen from requested physical ground spacing and advertised limits. At most **64 tiles**, **4 concurrent requests per worker**, **15-second socket timeouts**, **3 attempts** for transient network/408/429/5xx errors with bounded backoff, and an approximately **180-second fetch budget** keep requests bounded. The worker lowers zoom if necessary to meet the tile-count budget and reports this in the UI/sidecar. It does not silently substitute another provider or missing lower-zoom tiles. Missing tiles, invalid elevation support, metadata failures or server refusal produce a visible error and offer GeoTIFF import. Preview streams progress; Cancel or changing the area/source terminates that fetch worker. Generation uses the existing job progress/cancellation controls. Successfully cached tiles survive cancellation and are reused for generation.

**Resolution and licensing:** Mapterhorn combines global and regional datasets with differing resolution and licences; see its published metadata rather than assuming one universal licence. Tile zoom/pixel spacing is **not** native DEM resolution, vertical accuracy, or commercial-use permission. The published attribution catalogue lists sources but does not establish which source contributed to a particular pixel/selection. This version therefore labels exact underlying source, native resolution, area-specific licence and vertical datum **unknown / needs review**. The UI displays published attribution and the catalogue as possible source references. No country-based or zoom-based source guess is made. Catalogue-fetch failures do not invent credits; the sidecar records the failure and review link.

Every online STL job saves a `sourceMetadata` object in **settings-credits.json**: the TileJSON and catalogue snapshots (when retrievable), published attribution, metadata URLs, coverage, selected zoom, delivery sampling, fetch time, metric projection/extent, grid spacing, and unresolved provenance/licence fields. Review source-specific requirements before distributing or selling derived work. The provider's code licence does not grant blanket rights to its underlying terrain data. Online tiles are published for interactive terrain visualisation; no availability guarantee or blanket manufacturing/commercial-use permission is assumed.

Flow: rectangle → local Express API → Python Mapterhorn provider/cache → Terrarium decode → local metric elevation grid → **the same relief/base/tiling/mesh validation/STL path** used by GeoTIFF. `worker/mapterhorn.py` handles online fetching, `worker/providers.py` retains synthetic/GeoTIFF access, and `worker/grid.py` defines the common grid. No OpenTopography or other elevation provider is added. Do not treat basemap tiles as elevation.


Optional basemap/search terms and coverage:

- [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/): global community mapping with variable coverage, attribution required, best-effort public tiles, no bulk or offline prefetch. This app requests tiles only for interactive viewing and displays attribution.
- [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/): global OSM place search with variable completeness, maximum one request per second, no autocomplete, identify requests by browser Referer, no guaranteed availability. Search is explicit and throttled; coordinates always work offline.
- [OpenStreetMap copyright and ODbL](https://www.openstreetmap.org/copyright).

## Development and checks

```sh
npm run build
npm test
npm run test:api
# Optional live-service check (small online preview and STL export):
npm run test:api -- --online
```

`src/` contains the interface, MapLibre rectangle interactions and Three.js preview. `server/index.mjs` handles import, metadata, progress, cancellation and downloads. `worker/providers.py` handles elevation; `worker/main.py` builds/validates the solids. Tests exercise binary format, closed meshes, tiled boundaries, GeoTIFF coverage/NoData, Terrarium decoding (including fractional and negative elevations), tile seams, cache reuse, tile-size discovery, HTTP retry/cancellation/failure handling, metric spacing at high latitude, and online credits through the existing export path. Unit tests use deterministic WebP/TileJSON fixtures, not the live public service. `test:api` starts a separate loopback API on port 4312 and exercises local export/cancellation; its optional `--online` flag also makes actual Mapterhorn requests for a small Swiss selection and verifies an online STL/credits export. Output is capped at 1.5 million grid nodes and 12 × 12 tiles. STL size is estimated from 50 bytes per triangle; memory estimates are approximate. This first version runs Vite locally for launching; the build command checks TypeScript and produces frontend assets, but there is no hosted deployment configuration.
