export type SourceMetadata = {
  provider:string;attribution:string;attributionUrl:string;underlyingSource:string;
  nativeResolutionMetres:number|null;license:string;verticalDatum:string;
  tileZoom:number;tileSize:number;tileCount:number;tileGroundSamplingMetresApprox:number;
  zoomLimitedByRequestBudget:boolean;coverageBounds:[number,number,number,number];
  catalogueError:string|null;sourceCatalogue:unknown;
};
export function SourceCredits({metadata}:{metadata:SourceMetadata|null|undefined}){
  const entries=Array.isArray(metadata?.sourceCatalogue)?metadata.sourceCatalogue:[];
  return <div className="source-credits">
    <strong>Mapterhorn source credits</strong>
    <p>{metadata?.attribution||'Published attribution will be read with the elevation tiles.'} · <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">Published attribution & licences ↗</a></p>
    <dl>
      <dt>Underlying source</dt><dd>{metadata?.underlyingSource||'Unknown for this area — needs review'}</dd>
      <dt>Native source resolution</dt><dd>{metadata?.nativeResolutionMetres!=null?`${metadata.nativeResolutionMetres} m`:'Unknown — tile zoom is not dataset resolution'}</dd>
      <dt>Licence</dt><dd>{metadata?.license||'Unknown for this area — needs review. Commercial-use permission is not established.'}</dd>
      <dt>Vertical datum</dt><dd>{metadata?.verticalDatum||'Unknown — needs review'}</dd>
    </dl>
    {metadata&&<>
      <small>Published coverage (W, S, E, N): {metadata.coverageBounds.map(n=>n.toFixed(3)).join(', ')}. Actual coverage is checked at the sampled grid.</small>
      <small>Delivered tiles: zoom {metadata.tileZoom}, {metadata.tileSize} px; approximately {metadata.tileGroundSamplingMetresApprox.toFixed(1)} m/pixel here. This is delivery sampling, not native source resolution.</small>
      {metadata.zoomLimitedByRequestBudget&&<p className="warning">Tile detail was reduced to keep this selection within the 64-tile request limit. A smaller area can retain more detail.</p>}
      {metadata.catalogueError&&<small>The source catalogue could not be retrieved. Attribution and licence need manual review at the link above.</small>}
      {entries.length>0&&<details><summary>Published catalogue ({entries.length} possible sources)</summary><p>This reference list does not establish which source contributed to your area. Its metadata is saved with the STL.</p>{entries.map((entry,i)=>{
        if(typeof entry!=='object'||entry===null)return null;
        const e=entry as Record<string,unknown>;
        return <p key={i}><strong>{String(e.name||e.source||'Unnamed source')}</strong><br/>{String(e.producer||'Producer unknown')} · {String(e.license||'Licence unknown')}{typeof e.resolution==='number'&&<> · Catalogue sampling {e.resolution} m (not confirmed for this area)</>}</p>;
      })}</details>}
    </>}
    <small>Credits and the published metadata snapshot are saved in settings-credits.json beside the STL.</small>
  </div>;
}
