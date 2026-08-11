import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

type Track = {
  track_key: string;
  title: string;
  artists: string;
  image_url: string | null;
  is_playing: boolean;
  spotify_url: string | null;
  duration_ms: number | null;
  progress_ms: number | null;
};

type PollOutcome =
  | { kind: "success"; track: Track | null }
  | { kind: "error" };

type TrackLayerPhase = "current" | "entering" | "leaving";

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 3000;
const TRACK_TRANSITION_MS = 260;
const RESIZE_SETTLE_MS = 180;
const IMAGE_PRELOAD_TIMEOUT_MS = 800;

const appWindow = getCurrentWindow();

function pollDelay(outcome: PollOutcome, consecutiveErrors: number) {
  if (outcome.kind === "error") {
    return Math.min(15_000, 2000 * 2 ** Math.min(consecutiveErrors - 1, 3));
  }

  const currentTrack = outcome.track;
  if (!currentTrack?.is_playing) return IDLE_POLL_MS;

  if (
    currentTrack.duration_ms !== null &&
    currentTrack.progress_ms !== null
  ) {
    const remainingMs = currentTrack.duration_ms - currentTrack.progress_ms;
    if (remainingMs > 0 && remainingMs < ACTIVE_POLL_MS) {
      return Math.max(250, remainingMs + 120);
    }
  }

  return ACTIVE_POLL_MS;
}

export default function App() {
  const [track, setTrack] = useState<Track | null>(null);
  const [displayTrack, setDisplayTrack] = useState<Track | null>(null);
  const [previousTrack, setPreviousTrack] = useState<Track | null>(null);
  const [transitionNonce, setTransitionNonce] = useState(0);
  const [isWindowResizing, setIsWindowResizing] = useState(false);
  const [resizeNonce, setResizeNonce] = useState(0);
  const [clientId, setClientId] = useState(
    localStorage.getItem("spotify_client_id") || ""
  );
  const [status, setStatus] = useState("Spotifyに接続してください");
  const [busy, setBusy] = useState(false);

  const displayTrackRef = useRef<Track | null>(null);
  const latestTrackRef = useRef<Track | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  latestTrackRef.current = track;

  async function refresh(): Promise<PollOutcome> {
    try {
      const currentTrack = await invoke<Track | null>("now_playing");
      setTrack(currentTrack);
      setStatus(currentTrack ? "" : "再生中の曲がありません");
      return { kind: "success", track: currentTrack };
    } catch (error) {
      const notConnected = String(error).includes("not connected");
      if (notConnected) setTrack(null);
      setStatus(
        notConnected
          ? "Spotifyに接続してください"
          : "曲情報を取得できませんでした"
      );
      return { kind: "error" };
    }
  }

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let consecutiveErrors = 0;

    const poll = async () => {
      const outcome = await refresh();
      if (disposed) return;

      if (outcome.kind === "error") {
        consecutiveErrors += 1;
      } else {
        consecutiveErrors = 0;
      }

      timer = window.setTimeout(
        poll,
        pollDelay(outcome, consecutiveErrors)
      );
    };

    void poll();

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    let settleTimer: number | null = null;

    void appWindow.onResized(() => {
      setIsWindowResizing(true);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        setIsWindowResizing(false);
        setResizeNonce((value) => value + 1);
      }, RESIZE_SETTLE_MS);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        stopListening = unlisten;
      }
    });

    return () => {
      disposed = true;
      stopListening?.();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, []);

  useEffect(() => {
    const currentDisplay = displayTrackRef.current;
    if (track && currentDisplay?.track_key === track.track_key) {
      displayTrackRef.current = track;
      setDisplayTrack(track);
    }
  }, [track]);

  useEffect(() => {
    if (!track) {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      displayTrackRef.current = null;
      setDisplayTrack(null);
      setPreviousTrack(null);
      return;
    }

    const nextTrackKey = track.track_key;
    const currentDisplay = displayTrackRef.current;

    if (!currentDisplay) {
      displayTrackRef.current = track;
      setDisplayTrack(track);
      return;
    }

    if (currentDisplay.track_key === nextTrackKey) return;

    let cancelled = false;
    let committed = false;
    let preloadTimer: number | null = null;

    const commitTrackChange = () => {
      if (cancelled || committed) return;
      committed = true;

      const newestTrack = latestTrackRef.current;
      if (!newestTrack || newestTrack.track_key !== nextTrackKey) return;

      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }

      setPreviousTrack(displayTrackRef.current);
      displayTrackRef.current = newestTrack;
      setDisplayTrack(newestTrack);
      setTransitionNonce((value) => value + 1);
      transitionTimerRef.current = window.setTimeout(() => {
        setPreviousTrack(null);
        transitionTimerRef.current = null;
      }, TRACK_TRANSITION_MS);
    };

    if (track.image_url) {
      const image = new Image();
      image.onload = commitTrackChange;
      image.onerror = commitTrackChange;
      image.src = track.image_url;
      if (image.complete) commitTrackChange();
      preloadTimer = window.setTimeout(
        commitTrackChange,
        IMAGE_PRELOAD_TIMEOUT_MS
      );
    } else {
      commitTrackChange();
    }

    return () => {
      cancelled = true;
      if (preloadTimer !== null) window.clearTimeout(preloadTimer);
    };
  }, [track?.track_key, track?.image_url]);

  useEffect(
    () => () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
    },
    []
  );

  async function login() {
    const trimmedClientId = clientId.trim();
    if (!trimmedClientId) return;

    setBusy(true);
    try {
      localStorage.setItem("spotify_client_id", trimmedClientId);
      await invoke("spotify_login", { clientId: trimmedClientId });
      setStatus("接続しました");
      await refresh();
    } catch (error) {
      setStatus(`接続エラー: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function startMoving(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (
      target.closest(".close") ||
      target.closest(".resize") ||
      target.closest("input") ||
      target.closest("button")
    ) {
      return;
    }

    event.preventDefault();
    try {
      await appWindow.startDragging();
    } catch (error) {
      console.error("ウィンドウを移動できませんでした", error);
    }
  }

  if (!displayTrack) {
    return (
      <main className="shell login" onMouseDown={startMoving}>
        <ResizeHandles />
        <div className="loginBox">
          <div className="dot">♫</div>
          <strong>Spotify Now Playing</strong>
          <span>{status}</span>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="Spotify Client ID"
          />
          <button onClick={login} disabled={busy || !clientId.trim()}>
            {busy ? "ブラウザで認証中…" : "Spotifyに接続"}
          </button>
          <small>初回だけClient IDが必要です</small>
        </div>
      </main>
    );
  }

  const isTransitioning = previousTrack !== null;
  const marqueePaused = isWindowResizing || isTransitioning;

  return (
    <main
      className={`shell player ${
        displayTrack.is_playing ? "" : "paused"
      } ${marqueePaused ? "marqueePaused" : ""}`}
      onMouseDown={startMoving}
    >
      <ResizeHandles />

      {previousTrack && (
        <TrackLayer
          key={`previous-${transitionNonce}`}
          track={previousTrack}
          phase="leaving"
          marqueeRestartKey={`previous-${transitionNonce}`}
        />
      )}

      <TrackLayer
        key={`current-${displayTrack.track_key}-${transitionNonce}`}
        track={displayTrack}
        phase={isTransitioning ? "entering" : "current"}
        marqueeRestartKey={`${displayTrack.track_key}-${transitionNonce}-${resizeNonce}`}
      />

      <button
        className="close"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => appWindow.close()}
        aria-label="閉じる"
      >
        ×
      </button>
    </main>
  );
}

function TrackLayer({
  track,
  phase,
  marqueeRestartKey,
}: {
  track: Track;
  phase: TrackLayerPhase;
  marqueeRestartKey: string;
}) {
  return (
    <div
      className={`trackLayer ${phase}`}
      aria-hidden={phase === "leaving"}
    >
      {track.image_url && (
        <div
          className="ambientCover"
          style={{ backgroundImage: `url("${track.image_url}")` }}
        />
      )}

      <div className="darkOverlay" />

      {track.image_url ? (
        <img
          className="cover"
          src={track.image_url}
          alt=""
          draggable={false}
          decoding="async"
        />
      ) : (
        <div className="cover empty">♫</div>
      )}

      <div className="meta">
        <Marquee
          text={track.title}
          className="title"
          restartKey={`${marqueeRestartKey}-title`}
        />
        <Marquee
          text={track.artists}
          className="artist"
          restartKey={`${marqueeRestartKey}-artist`}
        />
      </div>
    </div>
  );
}

function Marquee({
  text,
  className,
  restartKey,
}: {
  text: string;
  className: string;
  restartKey: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [distance, setDistance] = useState(0);
  const [duration, setDuration] = useState(10);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    let animationFrame: number | null = null;

    const measure = () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const viewportWidth = viewport.clientWidth;
        const contentWidth = content.getBoundingClientRect().width;
        const overflows = contentWidth > viewportWidth + 2;

        setShouldScroll(overflows);
        if (overflows) {
          const gap = 32;
          setDistance(contentWidth + gap);
          setDuration(Math.max(8, (contentWidth + gap) / 28));
        } else {
          setDistance(0);
          setDuration(10);
        }
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);

    return () => {
      observer.disconnect();
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [text, restartKey]);

  return (
    <div
      ref={viewportRef}
      className={`marqueeViewport ${className}Viewport`}
    >
      <div
        key={restartKey}
        className={`marqueeTrack ${shouldScroll ? "isScrolling" : ""}`}
        style={
          {
            "--scroll-distance": `${distance}px`,
            "--scroll-duration": `${duration}s`,
          } as React.CSSProperties
        }
      >
        <span ref={contentRef} className={className}>
          {text}
        </span>
        {shouldScroll && (
          <>
            <span className="marqueeSpace" aria-hidden="true">
              &nbsp;
            </span>
            <span className={className} aria-hidden="true">
              {text}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function ResizeHandles() {
  const directions: Array<{
    className: string;
    direction: ResizeDirection;
  }> = [
    { className: "n", direction: "North" },
    { className: "s", direction: "South" },
    { className: "e", direction: "East" },
    { className: "w", direction: "West" },
    { className: "ne", direction: "NorthEast" },
    { className: "nw", direction: "NorthWest" },
    { className: "se", direction: "SouthEast" },
    { className: "sw", direction: "SouthWest" },
  ];

  return (
    <>
      {directions.map(({ className, direction }) => (
        <div
          key={className}
          className={`resize ${className}`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            appWindow.startResizeDragging(direction);
          }}
        />
      ))}
    </>
  );
}
