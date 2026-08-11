import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
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

type TrackLayerPhase = "current" | "entering";

type DisplaySettings = {
  transitionMs: number;
  blurPx: number;
  textScale: number;
};

const ACTIVE_POLL_MS = 400;
const IDLE_POLL_MS = 1000;
const RESIZE_SETTLE_MS = 180;
const IMAGE_PRELOAD_TIMEOUT_MS = 800;
const SETTINGS_STORAGE_KEY = "spotify_widget_display_settings";
const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  transitionMs: 1600,
  blurPx: 6,
  textScale: 100,
};

const appWindow = getCurrentWindow();

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function loadDisplaySettings(): DisplaySettings {
  try {
    const saved = JSON.parse(
      localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}"
    ) as Partial<DisplaySettings>;

    const savedBlur = Number(saved.blurPx);

    return {
      transitionMs: clamp(Number(saved.transitionMs) || 1600, 400, 2000),
      blurPx: Number.isFinite(savedBlur) ? clamp(savedBlur, 0, 24) : 6,
      textScale: clamp(Number(saved.textScale) || 100, 80, 140),
    };
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

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
  const [isTrackTransitioning, setIsTrackTransitioning] = useState(false);
  const [transitionNonce, setTransitionNonce] = useState(0);
  const [isWindowResizing, setIsWindowResizing] = useState(false);
  const [resizeNonce, setResizeNonce] = useState(0);
  const [clientId, setClientId] = useState(
    localStorage.getItem("spotify_client_id") || ""
  );
  const [status, setStatus] = useState("Spotifyに接続してください");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [displaySettings, setDisplaySettings] = useState(loadDisplaySettings);

  const displayTrackRef = useRef<Track | null>(null);
  const latestTrackRef = useRef<Track | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const displaySettingsRef = useRef(displaySettings);
  const previousWindowSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  latestTrackRef.current = track;
  displaySettingsRef.current = displaySettings;

  useEffect(() => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(displaySettings)
    );
  }, [displaySettings]);

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
      setIsTrackTransitioning(false);
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

      displayTrackRef.current = newestTrack;
      setDisplayTrack(newestTrack);
      setTransitionNonce((value) => value + 1);
      setIsTrackTransitioning(true);
      transitionTimerRef.current = window.setTimeout(() => {
        setIsTrackTransitioning(false);
        transitionTimerRef.current = null;
      }, displaySettingsRef.current.transitionMs);
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

  async function openSettings() {
    setSettingsOpen(true);

    try {
      const [size, scaleFactor] = await Promise.all([
        appWindow.innerSize(),
        appWindow.scaleFactor(),
      ]);
      const logicalSize = {
        width: size.width / scaleFactor,
        height: size.height / scaleFactor,
      };
      previousWindowSizeRef.current = logicalSize;
      await appWindow.setSize(
        new LogicalSize(Math.max(340, logicalSize.width), 180)
      );
    } catch (error) {
      console.error("設定画面用にウィンドウサイズを変更できませんでした", error);
    }
  }

  async function closeSettings() {
    setSettingsOpen(false);

    const previousSize = previousWindowSizeRef.current;
    previousWindowSizeRef.current = null;
    if (!previousSize) return;

    try {
      await appWindow.setSize(
        new LogicalSize(previousSize.width, previousSize.height)
      );
    } catch (error) {
      console.error("元のウィンドウサイズへ戻せませんでした", error);
    }
  }

  const displayStyle = {
    "--track-transition-duration": `${displaySettings.transitionMs}ms`,
    "--background-blur": `${displaySettings.blurPx}px`,
    "--title-font-min": `${13 * (displaySettings.textScale / 100)}px`,
    "--title-font-fluid": `${15 * (displaySettings.textScale / 100)}vh`,
    "--title-font-max": `${24 * (displaySettings.textScale / 100)}px`,
    "--artist-font-min": `${10 * (displaySettings.textScale / 100)}px`,
    "--artist-font-fluid": `${11 * (displaySettings.textScale / 100)}vh`,
    "--artist-font-max": `${17 * (displaySettings.textScale / 100)}px`,
  } as React.CSSProperties;

  if (settingsOpen) {
    return (
      <SettingsPanel
        settings={displaySettings}
        onChange={setDisplaySettings}
        onReset={() => setDisplaySettings(DEFAULT_DISPLAY_SETTINGS)}
        onClose={() => void closeSettings()}
        onMouseDown={startMoving}
      />
    );
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

  const isTransitioning = isTrackTransitioning;
  const marqueePaused = isWindowResizing || isTransitioning;

  return (
    <main
      className={`shell player ${
        displayTrack.is_playing ? "" : "paused"
      } ${marqueePaused ? "marqueePaused" : ""}`}
      style={displayStyle}
      onMouseDown={startMoving}
    >
      <ResizeHandles />

      <TrackLayer
        key={`current-${displayTrack.track_key}-${transitionNonce}`}
        track={displayTrack}
        phase={isTransitioning ? "entering" : "current"}
        marqueeRestartKey={`${displayTrack.track_key}-${transitionNonce}-${resizeNonce}`}
      />

      <button
        className="settingsButton"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => void openSettings()}
        aria-label="表示設定"
        title="表示設定"
      >
        ⚙
      </button>

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

function SettingsPanel({
  settings,
  onChange,
  onReset,
  onClose,
  onMouseDown,
}: {
  settings: DisplaySettings;
  onChange: (settings: DisplaySettings) => void;
  onReset: () => void;
  onClose: () => void;
  onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  const update = (change: Partial<DisplaySettings>) => {
    onChange({ ...settings, ...change });
  };

  return (
    <main className="shell settingsPanel" onMouseDown={onMouseDown}>
      <header className="settingsHeader">
        <strong>表示設定</strong>
        <button className="settingsDone" onClick={onClose}>
          完了
        </button>
      </header>

      <label className="settingRow">
        <span>全体の動き</span>
        <input
          type="range"
          min="400"
          max="2000"
          step="100"
          value={settings.transitionMs}
          onChange={(event) =>
            update({ transitionMs: Number(event.target.value) })
          }
        />
        <output>{(settings.transitionMs / 1000).toFixed(1)}秒</output>
      </label>

      <label className="settingRow">
        <span>背景ぼかし</span>
        <input
          type="range"
          min="0"
          max="24"
          step="1"
          value={settings.blurPx}
          onChange={(event) => update({ blurPx: Number(event.target.value) })}
        />
        <output>{settings.blurPx}px</output>
      </label>

      <label className="settingRow">
        <span>文字サイズ</span>
        <input
          type="range"
          min="80"
          max="140"
          step="5"
          value={settings.textScale}
          onChange={(event) =>
            update({ textScale: Number(event.target.value) })
          }
        />
        <output>{settings.textScale}%</output>
      </label>

      <button className="settingsReset" onClick={onReset}>
        初期値に戻す
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
    <div className={`trackLayer ${phase}`}>
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
