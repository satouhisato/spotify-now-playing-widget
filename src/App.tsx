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
  title: string;
  artists: string;
  image_url: string | null;
  is_playing: boolean;
  spotify_url: string | null;
};

const appWindow = getCurrentWindow();

export default function App() {
  const [track, setTrack] = useState<Track | null>(null);
  const [clientId, setClientId] = useState(
    localStorage.getItem("spotify_client_id") || ""
  );
  const [status, setStatus] = useState("Spotifyに接続してください");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const currentTrack = await invoke<Track | null>("now_playing");
      setTrack(currentTrack);
      setStatus(currentTrack ? "" : "再生中の曲がありません");
    } catch (error) {
      setTrack(null);
      setStatus(
        String(error).includes("not connected")
          ? "Spotifyに接続してください"
          : "曲情報を取得できませんでした"
      );
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, []);

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

  if (!track) {
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

  return (
    <main
      className={`shell player ${track.is_playing ? "" : "paused"}`}
      onMouseDown={startMoving}
    >
      <ResizeHandles />

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
        />
      ) : (
        <div className="cover empty">♫</div>
      )}

      <div className="meta">
        <Marquee text={track.title} className="title" />
        <Marquee text={track.artists} className="artist" />
      </div>

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

function Marquee({ text, className }: { text: string; className: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [distance, setDistance] = useState(0);
  const [duration, setDuration] = useState(10);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      const viewportWidth = viewport.clientWidth;
      const contentWidth = content.getBoundingClientRect().width;
      const overflows = contentWidth > viewportWidth + 2;

      setShouldScroll(overflows);
      if (overflows) {
        const gap = 32;
        setDistance(contentWidth + gap);
        setDuration(Math.max(8, (contentWidth + gap) / 28));
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      ref={viewportRef}
      className={`marqueeViewport ${className}Viewport`}
    >
      <div
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
