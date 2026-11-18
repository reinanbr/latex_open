import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { pdfjs, type PDFDocumentProxy } from "./pdfjs";
import "./pdf.css";

export type Zoom = number | "fit-width" | "fit-page";

export interface PdfHighlight {
  page: number; // 1-based
  x: number; // PDF points from the page's top-left
  y: number;
  w: number;
  h: number;
  nonce: number;
}

export interface PdfController {
  scrollToPage: (page: number) => void;
  numPages: () => number;
  scale: () => number;
}

interface Props {
  url: string;
  zoom?: Zoom;
  /** Reports the effective scale (useful to show "125%" for fit modes). */
  onScale?: (scale: number) => void;
  onLoaded?: (numPages: number) => void;
  onError?: (message: string) => void;
  onPageChange?: (page: number) => void;
  /** Double click in PDF points from the page's top-left. */
  onDoubleClick?: (page: number, x: number, y: number) => void;
  /** Ctrl/Cmd + wheel zoom requests. */
  onZoomRequest?: (factor: number) => void;
  highlight?: PdfHighlight | null;
  controllerRef?: RefObject<PdfController | null>;
}

interface PageSize {
  w: number;
  h: number;
}

const PAD = 12; // gap around/between pages (px)

export function PdfDocument({
  url,
  zoom = "fit-width",
  onScale,
  onLoaded,
  onError,
  onPageChange,
  onDoubleClick,
  onZoomRequest,
  highlight,
  controllerRef,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);
  const prevScale = useRef<number | null>(null);
  const currentPage = useRef(1);

  // Load the document; the previous one stays visible until the new one is ready.
  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    const task = pdfjs.getDocument({ url });
    task.promise
      .then(async (d) => {
        const s: PageSize[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          s.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) {
          void d.loadingTask.destroy();
          return;
        }
        loaded = true;
        setLoadError(null);
        setSizes(s);
        setDoc((old) => {
          // Let in-flight renders of the old document finish before freeing it.
          if (old) window.setTimeout(() => void old.loadingTask.destroy(), 2000);
          return d;
        });
        onLoaded?.(d.numPages);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        onError?.(msg);
      });
    return () => {
      cancelled = true;
      // A finished document is now owned by `doc` state; only abort pending loads.
      if (!loaded) void task.destroy().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Free the last document on unmount.
  const docRef = useRef<PDFDocumentProxy | null>(null);
  docRef.current = doc;
  useEffect(() => () => void docRef.current?.loadingTask.destroy(), []);

  // Track the container size for fit modes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const maxW = sizes.reduce((m, s) => Math.max(m, s.w), 0) || 595;
  const firstH = sizes[0]?.h ?? 842;
  let scale: number;
  if (typeof zoom === "number") scale = zoom;
  else if (box.w === 0) scale = 1;
  else {
    const fitW = (box.w - PAD * 2) / maxW;
    scale = zoom === "fit-width" ? fitW : Math.min(fitW, (box.h - PAD * 2) / firstH);
  }
  scale = Math.max(0.1, Math.min(scale, 8));

  useEffect(() => onScale?.(scale), [scale, onScale]);

  // Keep the viewport centered on the same content when the scale changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevScale.current;
    prevScale.current = scale;
    if (!el || prev === null || prev === scale) return;
    const r = scale / prev;
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * r - el.clientHeight / 2;
    el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * r - el.clientWidth / 2;
  }, [scale]);

  const pageTop = useCallback(
    (page: number) => {
      let y = PAD;
      for (let i = 0; i < page - 1 && i < sizes.length; i++) y += (sizes[i]?.h ?? 0) * scale + PAD;
      return y;
    },
    [sizes, scale],
  );

  if (controllerRef) {
    controllerRef.current = {
      scrollToPage: (p) => scrollRef.current?.scrollTo({ top: pageTop(p) - PAD }),
      numPages: () => sizes.length,
      scale: () => scale,
    };
  }

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return;
    const probe = el.scrollTop + el.clientHeight / 3;
    let y = PAD;
    let page = 1;
    for (let i = 0; i < sizes.length; i++) {
      const h = (sizes[i]?.h ?? 0) * scale + PAD;
      if (probe < y + h) {
        page = i + 1;
        break;
      }
      y += h;
      page = i + 1;
    }
    if (page !== currentPage.current) {
      currentPage.current = page;
      onPageChange?.(page);
    }
  };

  // Scroll a SyncTeX highlight into view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !highlight) return;
    const top = pageTop(highlight.page) + highlight.y * scale;
    el.scrollTo({ top: Math.max(0, top - el.clientHeight / 3), behavior: "smooth" });
  }, [highlight, pageTop, scale]);

  // Ctrl/Cmd + wheel zoom (needs a non-passive listener).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onZoomRequest) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      onZoomRequest(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onZoomRequest]);

  return (
    <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
      {loadError && !doc && <div className="pdf-message">Não foi possível abrir o PDF: {loadError}</div>}
      <div className="pdf-pages" style={{ padding: PAD, gap: PAD }}>
        {doc &&
          sizes.map((s, i) => (
            <PageView
              key={i}
              doc={doc}
              index={i + 1}
              width={s.w * scale}
              height={s.h * scale}
              scale={scale}
              root={scrollRef}
              highlight={highlight?.page === i + 1 ? highlight : null}
              onDoubleClick={onDoubleClick}
            />
          ))}
      </div>
    </div>
  );
}

function PageView({
  doc,
  index,
  width,
  height,
  scale,
  root,
  highlight,
  onDoubleClick,
}: {
  doc: PDFDocumentProxy;
  index: number;
  width: number;
  height: number;
  scale: number;
  root: RefObject<HTMLDivElement | null>;
  highlight: PdfHighlight | null;
  onDoubleClick?: (page: number, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [flash, setFlash] = useState<PdfHighlight | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), {
      root: root.current,
      rootMargin: "800px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  // Render (or re-render after zoom / new document) when visible. The new
  // canvas replaces the old one only once it is fully painted (no flicker).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    (async () => {
      const page = await doc.getPage(index);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const task = page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      renderTask = task;
      await task.promise;
      if (cancelled) return;
      canvasHost.current?.replaceChildren(canvas);

      const host = textHost.current;
      if (host) {
        const fresh = document.createElement("div");
        fresh.className = "textLayer";
        fresh.style.setProperty("--total-scale-factor", String(scale));
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: fresh, viewport });
        await textLayer.render();
        if (!cancelled) host.replaceChildren(fresh);
      }
    })().catch((err: unknown) => {
      if (!cancelled && !(err instanceof Error && err.name === "RenderingCancelledException")) {
        console.warn("pdf render failed", err);
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, index, scale, visible]);

  useEffect(() => {
    if (!highlight) return;
    setFlash(highlight);
    const t = window.setTimeout(() => setFlash(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlight]);

  return (
    <div
      ref={ref}
      className="pdf-page"
      data-page={index}
      style={{ width, height }}
      onDoubleClick={(e) => {
        if (!onDoubleClick) return;
        const r = e.currentTarget.getBoundingClientRect();
        onDoubleClick(index, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
        window.getSelection()?.removeAllRanges();
      }}
    >
      <div ref={canvasHost} className="pdf-canvas" />
      <div ref={textHost} className="pdf-text" />
      {flash && (
        <div
          key={flash.nonce}
          className="pdf-highlight"
          style={{
            left: flash.x * scale - 4,
            top: flash.y * scale - 4,
            width: Math.max(flash.w * scale, 24) + 8,
            height: Math.max(flash.h * scale, 12) + 8,
          }}
        />
      )}
    </div>
  );
}
