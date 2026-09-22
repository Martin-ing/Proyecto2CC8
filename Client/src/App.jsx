import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ImageClient } from './core/ImageClient.js';

const integer = value => new Intl.NumberFormat('es-GT').format(value);
const mib = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;

function Icon({ name, size = 20, ...props }) {
  const paths = {
    image: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m4 17 5-5 4 4 3-3 5 5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    up: <path d="m6 14 6-6 6 6" />,
    down: <path d="m6 10 6 6 6-6" />,
    left: <path d="m14 6-6 6 6 6" />,
    right: <path d="m10 6 6 6-6 6" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    grid: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M4 12h16M12 4v16" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    connection: <><path d="M5 8a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M11 16a2 2 0 0 1 2 0" /><circle cx="12" cy="20" r=".5" /></>,
    target: <><circle cx="12" cy="12" r="6" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

function Navigation({ client, state }) {
  const { view, selectedImage: image, transitioning } = state;
  const progress = image?.maxZoom ? view.zoom / image.maxZoom * 100 : 0;
  return <section className="navigation panel" aria-labelledby="navigation-title">
    <div className="section-heading"><h2 id="navigation-title">Explorar imagen</h2><Icon name="target" size={17} /></div>
    <div className="navigation-body">
      <div className="zoom-buttons">
        <button id="zoomInButton" className="zoom-button" aria-label="Zoom in" onClick={() => client.zoom(1)} disabled={!state.canZoomIn}><Icon name="plus" /><span>Zoom in</span><kbd>+</kbd></button>
        <button id="zoomOutButton" className="zoom-button" aria-label="Zoom out" onClick={() => client.zoom(-1)} disabled={!state.canZoomOut}><Icon name="minus" /><span>Zoom out</span><kbd>−</kbd></button>
      </div>
      <div className="direction-pad" aria-label="Desplazamiento de un tile">
        <button className="direction up" aria-label="Mover arriba" title="Mover arriba: un tile" disabled={!state.pan.up} onClick={() => client.pan(0, -1)}><Icon name="up" size={19} /></button>
        <button className="direction left" aria-label="Mover a la izquierda" title="Mover a la izquierda: un tile" disabled={!state.pan.left} onClick={() => client.pan(-1, 0)}><Icon name="left" size={19} /></button>
        <button className="direction down" aria-label="Mover abajo" title="Mover abajo: un tile" disabled={!state.pan.down} onClick={() => client.pan(0, 1)}><Icon name="down" size={19} /></button>
        <button className="direction right" aria-label="Mover a la derecha" title="Mover a la derecha: un tile" disabled={!state.pan.right} onClick={() => client.pan(1, 0)}><Icon name="right" size={19} /></button>
      </div>
    </div>
    <div className="level-line"><span>{image ? view.zoom === 0 ? 'Vista general · ROOT' : `Nivel ${view.zoom}` : 'Sin imagen seleccionada'}</span><span>{image ? `${view.zoom} / ${image.maxZoom}` : '—'}</span></div>
    <div className="level-track"><span style={{ width: `${progress}%` }} /></div>
    <p className={`navigation-hint ${transitioning ? 'is-transitioning' : ''}`}>{transitioning ? <><span className="spinner" /> Ajustando zoom · 1 segundo</> : 'Rueda o + / − para hacer zoom en el visor.'}</p>
  </section>;
}

function Catalog({ client, state }) {
  return <section className="catalog panel" aria-labelledby="catalog-title">
    <div className="section-heading"><h2 id="catalog-title">Imágenes disponibles</h2><span className="count-badge">{state.images.length.toString().padStart(2, '0')}</span></div>
    <button id="loadFilesButton" className="primary-button load-button" disabled={!state.ready || state.catalogLoading} onClick={() => client.loadCatalog()}><Icon name="refresh" size={17} /><span>{state.catalogLoading ? 'Cargando catálogo…' : 'Cargar imágenes'}</span></button>
    <div className="image-list" id="imageList">
      {!state.images.length && <div className="catalog-empty"><Icon name="image" size={29} /><p>{state.catalogLoaded ? 'No hay imágenes disponibles.' : 'Tu siguiente imagen empieza aquí.'}</p><span>{state.catalogLoaded ? 'Actualiza el catálogo cuando agregues una imagen al servidor.' : 'Carga el catálogo para explorar las imágenes del servidor.'}</span></div>}
      {state.images.map((image, index) => {
        const active = state.selectedImage?.id === image.id;
        return <article className={`image-card ${active ? 'selected' : ''}`} key={image.id}>
          <div className="image-card-top"><span className="image-index">{String(index + 1).padStart(2, '0')}</span><span className="image-id">{image.id}</span>{active && <span className="active-dot" title="Imagen seleccionada" />}</div>
          <h3 title={image.name}>{image.name}</h3>
          <p>{integer(image.width)} × {integer(image.height)} <span>px</span></p>
          <p className="image-meta">Virtual {integer(image.virtualSize)}² · Zoom máx. {image.maxZoom}</p>
          <button className="image-button" disabled={!state.ready || state.rootLoading || state.transitioning} onClick={() => client.requestRoot(image)}>
            <span>{active && state.rootLoading ? 'Cargando ROOT…' : 'Ver imagen'}</span><Icon name={active ? 'check' : 'arrow'} size={17} />
          </button>
        </article>;
      })}
    </div>
    <label className="format-control" htmlFor="rootFormat"><span>Formato de ROOT</span><select id="rootFormat" value={state.format} disabled={state.rootLoading} onChange={event => client.setFormat(event.target.value)}><option value="RGBA8888">RGBA8888 · 4 bytes/píxel</option><option value="RGBA4444">RGBA4444 · 2 bytes/píxel</option></select></label>
    <p className="field-hint">Se aplica al abrir una imagen.</p>
  </section>;
}

function Viewer({ canvasRef, client, state }) {
  const { selectedImage: image, view, rootInfo, rootLoading, transitioning } = state;
  const rootPercent = state.rootProgress.total ? Math.round(state.rootProgress.received / state.rootProgress.total * 100) : 0;
  const tilePercent = state.visibleTotal ? state.visibleReady / state.visibleTotal * 100 : rootInfo ? 100 : 0;
  return <section className="viewer-panel" aria-labelledby="viewer-title">
    <div className="viewer-heading"><div><p className="eyebrow">ESPACIO DE EXPLORACIÓN</p><h1 id="viewer-title">{image?.name || 'Una imagen, todos sus detalles.'}</h1></div><span className="viewer-mode"><Icon name="layers" size={15} />{image ? view.zoom === 0 ? 'ROOT' : `Nivel ${view.zoom}` : 'Visor'}</span></div>
    <div className={`canvas-stage ${rootInfo ? 'has-image' : ''}`}>
      <div className="canvas-frame">
        <canvas id="rootCanvas" ref={canvasRef} tabIndex={0} aria-label={image ? `Visor de ${image.name}. Usa más y menos para el zoom; flechas para desplazar.` : 'Visor de imágenes'} aria-busy={rootLoading || transitioning}
          onKeyDown={event => {
            const actions = { '+': () => client.zoom(1), '=': () => client.zoom(1), '-': () => client.zoom(-1), ArrowUp: () => client.pan(0, -1), ArrowDown: () => client.pan(0, 1), ArrowLeft: () => client.pan(-1, 0), ArrowRight: () => client.pan(1, 0) };
            if (actions[event.key]) { event.preventDefault(); if (!event.repeat) actions[event.key](); }
          }} />
        {!rootInfo && <div className="viewer-empty">
          <div className={`empty-icon ${rootLoading ? 'loading' : ''}`}><Icon name={rootLoading ? 'layers' : 'image'} size={38} /></div>
          <h2>{rootLoading ? 'Preparando la vista general' : 'Elige una imagen para comenzar'}</h2>
          <p>{rootLoading ? `Recibiendo ROOT · ${rootPercent}%` : 'Carga las imágenes y abre una desde el panel izquierdo.'}</p>
          {rootLoading && <div className="root-load-track"><span style={{ width: `${rootPercent}%` }} /></div>}
        </div>}
      </div>
      {rootInfo && <div className="canvas-corner"><span className="small-dot" />ROOT en memoria</div>}
      {transitioning && <div className="transition-badge" role="status"><span className="spinner" />Nivel {state.transitionFrom} → {view.zoom}</div>}
    </div>
    <div className="viewer-caption"><span><span className={`small-dot ${rootInfo ? 'green' : ''}`} />{rootInfo ? view.zoom === 0 ? 'Vista general completa' : state.visibleReady === 16 ? 'Detalle completo' : 'Completando detalle sobre el fondo anterior' : 'Esperando imagen'}</span><span>{image ? `${integer(image.width)} × ${integer(image.height)} px` : 'Carga progresiva por niveles'}</span></div>
    <div className="metrics">
      <div className="metric"><span className="metric-label">NIVEL ACTUAL</span><strong>{image ? String(view.zoom).padStart(2, '0') : '—'}<small>{image ? ` / ${image.maxZoom}` : ''}</small></strong><span>{image ? view.zoom === 0 ? 'Vista general · ROOT' : `${integer(state.axisTiles)} × ${integer(state.axisTiles)} tiles en el nivel` : 'Selecciona una imagen'}</span></div>
      <div className="metric"><span className="metric-label">TILES VISIBLES</span><strong>{rootInfo ? view.zoom === 0 ? 'ROOT' : state.visibleReady : '—'}<small>{view.zoom > 0 ? ' / 16' : ''}</small></strong><div className="metric-progress"><span style={{ width: `${tilePercent}%` }} /></div></div>
      <div className="metric"><span className="metric-label">CACHÉ DE TILES</span><strong>{state.cacheSize}<small> tiles</small></strong><span>{mib(state.cacheBytes)} de datos recibidos</span></div>
      <div className="metric"><span className="metric-label">VENTANA ACTUAL</span><strong className="coordinates">{view.zoom > 0 ? `${view.currentX}, ${view.currentY}` : '—'}</strong><span>{view.zoom > 0 ? 'Tile superior izquierdo · 4 × 4' : 'Espacio virtual completo'}</span></div>
    </div>
  </section>;
}

function Connection({ client, state }) {
  const [url, setUrl] = useState(state.url);
  return <section className="connection-panel" aria-label="Información de conexión y carga">
    <div className="connection-top"><div className={`status-message ${state.error ? 'error' : ''}`} role="status"><span className={`small-dot ${state.ready ? 'green' : ''}`} /><span>{state.status}</span></div><div className="channel-chips">{state.channels.map(channel => <span className={`channel-chip ${channel.joined ? 'online' : ''}`} key={channel.name}><span className="small-dot" />{channel.name}{channel.progress && <b>{channel.progress}</b>}</span>)}</div></div>
    <details className="technical-details"><summary>Detalles de conexión y carga <Icon name="down" size={14} /></summary>
      <div className="technical-grid">
        <div><span>ROOT</span><p>{state.rootInfo ? `${state.rootInfo.width} × ${state.rootInfo.height} · ${state.rootInfo.format}` : state.rootLoading ? `${state.rootProgress.received}/${state.rootProgress.total || '?'} chunks` : 'Sin cargar'}</p></div>
        <div><span>Caché deseada</span><p>{state.desiredReady}/{state.desiredCount} tiles · {state.retainedCount} retenidos para transición</p></div>
        <div><span>Sesión / vista</span><p>{state.sessionId || '—'} / {state.view.viewId || 'ROOT'}</p></div>
        <div><span>Canales de datos</span><p>Tiles 256 × 256 · RGBA4444 · CONTROL + 3 canales</p></div>
      </div>
      <form className="server-form" onSubmit={event => { event.preventDefault(); client.connect(url.trim()); }}><label htmlFor="serverUrl">Servidor WebSocket</label><input id="serverUrl" type="text" spellCheck="false" value={url} onChange={event => setUrl(event.target.value)} placeholder="ws://localhost:8080/ws" /><button type="submit" className="secondary-button" disabled={state.connection === 'connecting'}><Icon name="connection" size={16} />Reconectar</button></form>
    </details>
  </section>;
}

export default function App() {
  const [client] = useState(() => new ImageClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    client.renderer.attach(canvas);
    client.connect();
    const wheel = event => {
      if (!client.rootInfo) return;
      event.preventDefault();
      if (Math.abs(event.deltaY) >= 4) client.zoom(event.deltaY < 0 ? 1 : -1);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => { canvas.removeEventListener('wheel', wheel); client.dispose(); };
  }, [client]);
  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-icon"><Icon name="image" size={24} /></span><div><strong>Visor de imágenes<span className="brand-dot">.</span></strong><p>Exploración de alta resolución</p></div></div><div className="header-right"><span className="project-label">CC8 <span>/</span> PROYECTO 2</span><span className={`connection-pill ${state.ready ? 'online' : ''}`}><span className="small-dot" />{state.ready ? 'Servidor conectado' : state.connection === 'connecting' ? 'Conectando' : 'Sin conexión completa'}</span></div></header>
    <main className="workspace">
      <aside className="sidebar"><Navigation client={client} state={state} /><Catalog client={client} state={state} /><p className="sidebar-note"><Icon name="layers" size={15} />Más detalle, una capa a la vez.</p></aside>
      <div className="main-content"><Viewer canvasRef={canvasRef} client={client} state={state} /><Connection client={client} state={state} /><footer className="workspace-footer"><span>VISOR MULTIRRESOLUCIÓN</span><span>React · WebSocket</span></footer></div>
    </main>
  </div>;
}
