import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
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

type TrackLayerPhase = "current" | "entering" | "leaving";

type TransitionMode = "focus" | "slide";
type CoverShape = "rounded" | "square" | "circle" | "disc";
type BackgroundStyle = "dark" | "vivid" | "frost" | "glass";
type BandShape = "rounded" | "square";
type BandEdge = "solid" | "fade";
type TextAlignment = "left" | "center";

type PlaybackProgress = {
  track_key: string;
  duration_ms: number | null;
  progress_ms: number | null;
  is_playing: boolean;
};

type InstalledFontCatalog = {
  latin: string[];
  japanese: string[];
};

type ArtworkAnalysis = {
  accent: { red: number; green: number; blue: number };
  luminance: number;
};

type DisplaySettings = {
  transitionMode: TransitionMode;
  focusTransitionMs: number;
  slideTransitionMs: number;
  blurPx: number;
  textScale: number;
  latinFont: string;
  japaneseFont: string;
  coverShape: CoverShape;
  bandThickness: number;
  bandShape: BandShape;
  bandEdge: BandEdge;
  fadeLength: number;
  fadeStrength: number;
  backgroundStyle: BackgroundStyle;
  colorSaturation: number;
  glassReflection: number;
  artistOpacity: number;
  textAlignment: TextAlignment;
  progressBarEnabled: boolean;
  discSpinEnabled: boolean;
  discSpinSeconds: number;
};

type PresetWindowSize = {
  width: number;
  height: number;
};

type CustomPreset = {
  id: string;
  name: string;
  settings: DisplaySettings;
  updatedAt: number;
  windowSize?: PresetWindowSize;
};

type PresetExport = {
  schemaVersion: 1;
  exportedAt: string;
  presets: CustomPreset[];
};

const RESIZE_SETTLE_MS = 180;
const IMAGE_PRELOAD_TIMEOUT_MS = 800;
const PROGRESS_SEEK_THRESHOLD_MS = 2_500;
const SETTINGS_STORAGE_KEY = "spotify_widget_display_settings";
const PRESETS_STORAGE_KEY = "spotify_widget_custom_presets";
const MAX_CUSTOM_PRESETS = 12;
const APP_FONT_SEGOE = "@app/segoe-ui";
const APP_FONT_NOTO = "@app/noto-sans-jp";
const APP_FONT_ZEN = "@app/zen-kaku-gothic-new";
const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  transitionMode: "focus",
  focusTransitionMs: 1600,
  slideTransitionMs: 3000,
  blurPx: 6,
  textScale: 100,
  latinFont: APP_FONT_SEGOE,
  japaneseFont: APP_FONT_NOTO,
  coverShape: "rounded",
  bandThickness: 84,
  bandShape: "rounded",
  bandEdge: "solid",
  fadeLength: 30,
  fadeStrength: 70,
  backgroundStyle: "dark",
  colorSaturation: 120,
  glassReflection: 65,
  artistOpacity: 86,
  textAlignment: "left",
  progressBarEnabled: true,
  discSpinEnabled: true,
  discSpinSeconds: 12,
};

const appWindow = getCurrentWindow();

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeDisplaySettings(value: unknown): DisplaySettings {
  const saved = (value && typeof value === "object" ? value : {}) as Omit<
    Partial<DisplaySettings>,
    "coverShape"
  > & {
    transitionMs?: number;
    fontStyle?: string;
    coverShape?: string;
  };

  const savedBlur = Number(saved.blurPx);
  const legacyTransitionMs = Number(saved.transitionMs);
  const savedSpinSeconds = Number(saved.discSpinSeconds);
  const savedFadeStrength = Number(
    saved.fadeStrength ?? (saved as { fadeCurve?: number }).fadeCurve
  );
  const savedColorSaturation = Number(saved.colorSaturation);
  const savedGlassReflection = Number(saved.glassReflection);

  return {
    transitionMode: saved.transitionMode === "slide" ? "slide" : "focus",
    focusTransitionMs: clamp(
      Number(saved.focusTransitionMs) || legacyTransitionMs || 1600,
      400,
      2000
    ),
    slideTransitionMs: clamp(
      Number(saved.slideTransitionMs) || 3000,
      400,
      5000
    ),
    blurPx: Number.isFinite(savedBlur) ? clamp(savedBlur, 0, 24) : 6,
    textScale: clamp(Number(saved.textScale) || 100, 50, 140),
    latinFont:
      typeof saved.latinFont === "string" &&
      saved.latinFont !== APP_FONT_NOTO &&
      saved.latinFont !== APP_FONT_ZEN
        ? saved.latinFont
        : APP_FONT_SEGOE,
    japaneseFont:
      typeof saved.japaneseFont === "string"
        ? saved.japaneseFont
        : saved.fontStyle === "zen" || saved.fontStyle === "rounded"
          ? APP_FONT_ZEN
          : APP_FONT_NOTO,
    coverShape:
      saved.coverShape === "square" ||
      saved.coverShape === "circle" ||
      saved.coverShape === "disc"
        ? saved.coverShape
        : saved.coverShape === "vinyl" || saved.coverShape === "cd"
          ? "disc"
          : "rounded",
    bandThickness: clamp(Number(saved.bandThickness) || 84, 60, 100),
    bandShape: saved.bandShape === "square" ? "square" : "rounded",
    bandEdge: saved.bandEdge === "fade" ? "fade" : "solid",
    fadeLength: clamp(Number(saved.fadeLength) || 30, 15, 60),
    fadeStrength: Number.isFinite(savedFadeStrength)
      ? clamp(savedFadeStrength, 40, 100)
      : 70,
    backgroundStyle:
      saved.backgroundStyle === "vivid" ||
      saved.backgroundStyle === "frost" ||
      saved.backgroundStyle === "glass"
        ? saved.backgroundStyle
        : "dark",
    colorSaturation: Number.isFinite(savedColorSaturation)
      ? clamp(savedColorSaturation, 100, 160)
      : 120,
    glassReflection: Number.isFinite(savedGlassReflection)
      ? clamp(savedGlassReflection, 0, 100)
      : 65,
    artistOpacity: clamp(Number(saved.artistOpacity) || 86, 50, 100),
    textAlignment: saved.textAlignment === "center" ? "center" : "left",
    progressBarEnabled: saved.progressBarEnabled !== false,
    discSpinEnabled: saved.discSpinEnabled !== false,
    discSpinSeconds: Number.isFinite(savedSpinSeconds)
      ? clamp(savedSpinSeconds, 4, 30)
      : 12,
  };
}

function loadDisplaySettings(): DisplaySettings {
  try {
    return normalizeDisplaySettings(
      JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}")
    );
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

function normalizeWindowSize(value: unknown): PresetWindowSize | undefined {
  if (!value || typeof value !== "object") return undefined;
  const size = value as Partial<PresetWindowSize>;
  const width = Number(size.width);
  const height = Number(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return {
    width: clamp(Math.round(width), 180, 520),
    height: clamp(Math.round(height), 72, 180),
  };
}

function normalizeCustomPresets(value: unknown): CustomPreset[] {
  const source = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as Partial<PresetExport>).presets)
      ? (value as Partial<PresetExport>).presets ?? []
      : [];

  return source
    .filter(
      (preset): preset is Partial<CustomPreset> =>
        Boolean(preset) &&
        typeof preset === "object" &&
        Boolean(preset.settings) &&
        typeof preset.settings === "object"
    )
    .map((preset, index) => ({
      id:
        typeof preset.id === "string" && preset.id
          ? preset.id
          : `legacy-${index}`,
      name:
        typeof preset.name === "string" && preset.name.trim()
          ? preset.name.trim().slice(0, 24)
          : `プリセット ${index + 1}`,
      settings: normalizeDisplaySettings(preset.settings),
      updatedAt: Number(preset.updatedAt) || 0,
      windowSize: normalizeWindowSize(preset.windowSize),
    }))
    .slice(0, MAX_CUSTOM_PRESETS);
}

function loadCustomPresets(): CustomPreset[] {
  try {
    return normalizeCustomPresets(
      JSON.parse(localStorage.getItem(PRESETS_STORAGE_KEY) || "[]")
    );
  } catch {
    return [];
  }
}

function createPresetId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cssFontFamily(font: string) {
  if (font === APP_FONT_SEGOE) {
    return '"Segoe UI Variable Text", "Segoe UI"';
  }
  if (font === APP_FONT_ZEN) return '"Zen Kaku Gothic New"';
  if (font === APP_FONT_NOTO || !font) return '"Noto Sans JP Variable"';
  return JSON.stringify(font);
}

function transitionDuration(
  settings: DisplaySettings,
  mode: TransitionMode
) {
  return mode === "slide"
    ? settings.slideTransitionMs
    : settings.focusTransitionMs;
}

export default function App() {
  const [track, setTrack] = useState<Track | null>(null);
  const [displayTrack, setDisplayTrack] = useState<Track | null>(null);
  const [previousTrack, setPreviousTrack] = useState<Track | null>(null);
  const [isTrackTransitioning, setIsTrackTransitioning] = useState(false);
  const [activeTransitionMode, setActiveTransitionMode] =
    useState<TransitionMode>("focus");
  const [transitionNonce, setTransitionNonce] = useState(0);
  const [isWindowResizing, setIsWindowResizing] = useState(false);
  const [resizeNonce, setResizeNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [displaySettings, setDisplaySettings] = useState(loadDisplaySettings);
  const [customPresets, setCustomPresets] = useState(loadCustomPresets);
  const [fontCatalog, setFontCatalog] = useState<InstalledFontCatalog>({
    latin: [],
    japanese: [],
  });

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

  useEffect(() => {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(customPresets));
  }, [customPresets]);

  useEffect(() => {
    let disposed = false;
    void invoke<InstalledFontCatalog>("installed_fonts")
      .then((catalog) => {
        if (!disposed) setFontCatalog(catalog);
      })
      .catch((error) => {
        console.error("インストール済みフォントを取得できませんでした", error);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    const initialize = async () => {
      stopListening = await listen<Track | null>(
        "media-session-track",
        (event) => {
          if (!disposed) setTrack(event.payload);
        }
      );
      const currentTrack = await invoke<Track | null>("now_playing");
      if (!disposed) setTrack(currentTrack);
    };

    void initialize().catch((error) => {
      console.error("Windowsメディアセッションを開始できませんでした", error);
    });

    return () => {
      disposed = true;
      stopListening?.();
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

      const nextSettings = displaySettingsRef.current;
      const nextTransitionMode = nextSettings.transitionMode;
      const nextTransitionDuration = transitionDuration(
        nextSettings,
        nextTransitionMode
      );

      setPreviousTrack(
        nextTransitionMode === "slide" ? displayTrackRef.current : null
      );
      displayTrackRef.current = newestTrack;
      setDisplayTrack(newestTrack);
      setTransitionNonce((value) => value + 1);
      setActiveTransitionMode(nextTransitionMode);
      setIsTrackTransitioning(true);
      transitionTimerRef.current = window.setTimeout(() => {
        setPreviousTrack(null);
        setIsTrackTransitioning(false);
        transitionTimerRef.current = null;
      }, nextTransitionDuration);
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

  async function startMoving(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (
      target.closest(".close") ||
      target.closest(".resize") ||
      target.closest("input") ||
      target.closest("select") ||
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
        new LogicalSize(Math.max(440, logicalSize.width), 180)
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

  async function presetWindowSize(
    includeWindowSize: boolean
  ): Promise<PresetWindowSize | undefined> {
    if (!includeWindowSize) return undefined;
    if (previousWindowSizeRef.current) {
      return normalizeWindowSize(previousWindowSizeRef.current);
    }

    const [size, scaleFactor] = await Promise.all([
      appWindow.innerSize(),
      appWindow.scaleFactor(),
    ]);
    return normalizeWindowSize({
      width: size.width / scaleFactor,
      height: size.height / scaleFactor,
    });
  }

  const blurRatio = clamp(displaySettings.blurPx / 24, 0, 1);
  const detailFactor = 1 - blurRatio;
  const colorStrength = clamp(
    (displaySettings.colorSaturation - 100) / 60,
    0,
    1
  );
  const glassReflectionScale = displaySettings.glassReflection / 65;
  const displayStyle = {
    "--track-transition-duration": `${transitionDuration(
      displaySettings,
      activeTransitionMode
    )}ms`,
    "--background-blur": `${displaySettings.blurPx}px`,
    "--dark-saturation": 1 + blurRatio * 0.05,
    "--dark-brightness": 0.86 + blurRatio * 0.06,
    "--dark-overlay-start": 0.06 + detailFactor * 0.04,
    "--dark-overlay-mid": 0.12 + detailFactor * 0.06,
    "--dark-overlay-strong": 0.22 + detailFactor * 0.08,
    "--dark-overlay-end": 0.32 + detailFactor * 0.1,
    "--vivid-saturation":
      1 + colorStrength * (0.45 + blurRatio * 0.1),
    "--vivid-contrast":
      1 + colorStrength * (0.14 - blurRatio * 0.06),
    "--vivid-brightness": 1 + colorStrength * 0.04,
    "--vivid-overlay-start":
      0.01 + detailFactor * 0.02 + colorStrength * (0.01 + detailFactor * 0.02),
    "--vivid-overlay-mid":
      0.04 + detailFactor * 0.04 + colorStrength * (0.04 + detailFactor * 0.03),
    "--vivid-overlay-end":
      0.1 + detailFactor * 0.06 + colorStrength * (0.1 + detailFactor * 0.04),
    "--frost-saturation": 0.68 + blurRatio * 0.1,
    "--frost-brightness": 1.14 + blurRatio * 0.06,
    "--frost-overlay-start": 0.36 + detailFactor * 0.14,
    "--frost-overlay-mid": 0.58 + detailFactor * 0.12,
    "--frost-overlay-end": 0.76 + detailFactor * 0.1,
    "--glass-saturation": 1.08 + blurRatio * 0.14,
    "--glass-brightness": 1.02 + blurRatio * 0.06,
    "--glass-fill-alpha": 0.12 + detailFactor * 0.08,
    "--glass-soft-alpha": 0.066 + detailFactor * 0.044,
    "--glass-shade-alpha": 0.16 + detailFactor * 0.08,
    "--glass-highlight-alpha":
      (0.36 + blurRatio * 0.12) * glassReflectionScale,
    "--glass-diagonal-alpha": 0.14 * glassReflectionScale,
    "--glass-surface-opacity": clamp(0.78 * glassReflectionScale, 0, 1),
    "--glass-glint-opacity": clamp(0.66 * glassReflectionScale, 0, 1),
    "--title-font-min": `${13 * (displaySettings.textScale / 100)}px`,
    "--title-font-fluid": `${15 * (displaySettings.textScale / 100)}vh`,
    "--title-font-max": `${24 * (displaySettings.textScale / 100)}px`,
    "--artist-font-min": `${10 * (displaySettings.textScale / 100)}px`,
    "--artist-font-fluid": `${11 * (displaySettings.textScale / 100)}vh`,
    "--artist-font-max": `${17 * (displaySettings.textScale / 100)}px`,
    "--artist-opacity": displaySettings.artistOpacity / 100,
    "--artist-gap": `${clamp(
      (displaySettings.bandThickness - 50) / 8 + 2,
      2,
      8
    )}px`,
    "--disc-spin-duration": `${displaySettings.discSpinSeconds}s`,
    "--band-inset": `${(100 - displaySettings.bandThickness) / 2}%`,
    "--band-fade-start": `${100 - displaySettings.fadeLength}%`,
    "--band-fade-end-opacity": clamp(
      1 - displaySettings.fadeStrength / 100,
      0,
      0.6
    ),
    "--latin-font-family": cssFontFamily(displaySettings.latinFont),
    "--japanese-font-family": cssFontFamily(displaySettings.japaneseFont),
  } as React.CSSProperties;

  if (settingsOpen) {
    return (
      <SettingsPanel
        settings={displaySettings}
        fontCatalog={fontCatalog}
        customPresets={customPresets}
        onChange={setDisplaySettings}
        onCreatePreset={async (name, includeWindowSize) => {
          const preset: CustomPreset = {
            id: createPresetId(),
            name,
            settings: { ...displaySettings },
            updatedAt: Date.now(),
            windowSize: await presetWindowSize(includeWindowSize),
          };
          setCustomPresets((current) =>
            [preset, ...current].slice(0, MAX_CUSTOM_PRESETS)
          );
          return preset.id;
        }}
        onUpdatePreset={async (id, name, includeWindowSize) => {
          const windowSize = await presetWindowSize(includeWindowSize);
          setCustomPresets((current) =>
            current.map((preset) =>
              preset.id === id
                ? {
                    ...preset,
                    name,
                    settings: { ...displaySettings },
                    updatedAt: Date.now(),
                    windowSize,
                  }
                : preset
            )
          );
        }}
        onApplyPreset={(preset) => {
          setDisplaySettings({ ...preset.settings });
          if (preset.windowSize) {
            previousWindowSizeRef.current = { ...preset.windowSize };
          }
        }}
        onDeletePreset={(id) => {
          setCustomPresets((current) =>
            current.filter((preset) => preset.id !== id)
          );
        }}
        onImportPresets={(value) => {
          const availableSlots = MAX_CUSTOM_PRESETS - customPresets.length;
          const imported = normalizeCustomPresets(value)
            .slice(0, availableSlots)
            .map((preset) => ({
              ...preset,
              id: createPresetId(),
              updatedAt: Date.now(),
            }));
          if (imported.length > 0) {
            setCustomPresets((current) => [...current, ...imported]);
          }
          return imported.length;
        }}
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
        <WindowButtons onOpenSettings={() => void openSettings()} />
        <div className="loginBox">
          <div className="dot">♫</div>
          <strong>Spotify Now Playing</strong>
          <span>Spotifyで曲を再生してください</span>
          <small>Windowsの再生情報から自動で表示します</small>
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
      } ${marqueePaused ? "marqueePaused" : ""} transition${
        activeTransitionMode === "slide" ? "Slide" : "Focus"
      } cover-${displaySettings.coverShape} background-${
        displaySettings.backgroundStyle
      } band-${displaySettings.bandShape} band-edge-${
        displaySettings.bandEdge
      } text-layout-${displaySettings.textAlignment} ${
        displaySettings.discSpinEnabled ? "disc-spin-enabled" : ""
      }`}
      style={displayStyle}
      onMouseDown={startMoving}
    >
      <ResizeHandles />

      {previousTrack && activeTransitionMode === "slide" && (
        <TrackLayer
          key={`previous-${transitionNonce}`}
          track={previousTrack}
          phase="leaving"
          marqueeRestartKey={`previous-${transitionNonce}`}
          progressBarEnabled={displaySettings.progressBarEnabled}
          backgroundStyle={displaySettings.backgroundStyle}
          blurPx={displaySettings.blurPx}
          colorSaturation={displaySettings.colorSaturation}
        />
      )}

      <TrackLayer
        key={`current-${displayTrack.track_key}-${transitionNonce}`}
        track={displayTrack}
        phase={isTransitioning ? "entering" : "current"}
        marqueeRestartKey={`${displayTrack.track_key}-${transitionNonce}-${resizeNonce}`}
        progressBarEnabled={displaySettings.progressBarEnabled}
        backgroundStyle={displaySettings.backgroundStyle}
        blurPx={displaySettings.blurPx}
        colorSaturation={displaySettings.colorSaturation}
      />

      <WindowButtons onOpenSettings={() => void openSettings()} />
    </main>
  );
}

function WindowButtons({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <>
      <button
        className="settingsButton"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onOpenSettings}
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
        title="閉じる"
      >
        ×
      </button>
    </>
  );
}

function SettingsPanel({
  settings,
  fontCatalog,
  customPresets,
  onChange,
  onCreatePreset,
  onUpdatePreset,
  onApplyPreset,
  onDeletePreset,
  onImportPresets,
  onReset,
  onClose,
  onMouseDown,
}: {
  settings: DisplaySettings;
  fontCatalog: InstalledFontCatalog;
  customPresets: CustomPreset[];
  onChange: (settings: DisplaySettings) => void;
  onCreatePreset: (name: string, includeWindowSize: boolean) => Promise<string>;
  onUpdatePreset: (
    id: string,
    name: string,
    includeWindowSize: boolean
  ) => Promise<void>;
  onApplyPreset: (preset: CustomPreset) => void;
  onDeletePreset: (id: string) => void;
  onImportPresets: (value: unknown) => number;
  onReset: () => void;
  onClose: () => void;
  onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [appliedPresetId, setAppliedPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [includeWindowSize, setIncludeWindowSize] = useState(false);
  const [presetMessage, setPresetMessage] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);

  const update = (change: Partial<DisplaySettings>) => {
    setPresetMessage("");
    onChange({ ...settings, ...change });
  };

  const selectedPreset = customPresets.find(
    (preset) => preset.id === selectedPresetId
  );
  const normalizedPresetName = presetName.trim().slice(0, 24);
  const presetSettingsMatch = Boolean(
    selectedPreset &&
      JSON.stringify(selectedPreset.settings) === JSON.stringify(settings)
  );
  const presetMetadataChanged = Boolean(
    selectedPreset &&
      (selectedPreset.name !== normalizedPresetName ||
        Boolean(selectedPreset.windowSize) !== includeWindowSize)
  );
  const presetHasChanges = Boolean(
    selectedPreset &&
      (presetMetadataChanged ||
        (appliedPresetId === selectedPreset.id && !presetSettingsMatch))
  );
  const presetStatus = presetHasChanges
    ? "変更あり"
    : presetSettingsMatch
      ? "保存済み"
      : "未適用";

  const selectPreset = (id: string) => {
    setSelectedPresetId(id);
    const preset = customPresets.find((item) => item.id === id);
    setPresetName(preset?.name ?? "");
    setIncludeWindowSize(Boolean(preset?.windowSize));
    setPresetMessage("");
  };

  const savePreset = async () => {
    if (!normalizedPresetName) return;
    if (selectedPreset) {
      await onUpdatePreset(
        selectedPreset.id,
        normalizedPresetName,
        includeWindowSize
      );
      setAppliedPresetId(selectedPreset.id);
      setPresetMessage("上書きしました");
      return;
    }
    if (customPresets.length >= MAX_CUSTOM_PRESETS) return;
    const createdPresetId = await onCreatePreset(
      normalizedPresetName,
      includeWindowSize
    );
    setSelectedPresetId(createdPresetId);
    setAppliedPresetId(createdPresetId);
    setPresetName(normalizedPresetName);
    setPresetMessage("保存しました");
  };

  const exportPresets = () => {
    const payload: PresetExport = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      presets: customPresets,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      })
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "spotify-widget-presets.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setPresetMessage(`${customPresets.length}件を書き出しました`);
  };

  const importPresets = async (file: File) => {
    try {
      const importedCount = onImportPresets(JSON.parse(await file.text()));
      setPresetMessage(
        importedCount > 0
          ? `${importedCount}件を読み込みました`
          : "読み込めるプリセットがありません"
      );
    } catch {
      setPresetMessage("JSONファイルを読み込めませんでした");
    }
  };

  const selectedTransitionMs = transitionDuration(
    settings,
    settings.transitionMode
  );
  const selectedTransitionMax =
    settings.transitionMode === "slide" ? 5000 : 2000;

  return (
    <main className="shell settingsPanel" onMouseDown={onMouseDown}>
      <header className="settingsHeader">
        <strong>表示設定</strong>
        <button className="settingsDone" onClick={onClose}>
          完了
        </button>
      </header>

      <div className="settingsScroll">
        <SettingsSection title="カスタムプリセット" className="presetSection">
          <div className="presetHeadingStatus" aria-live="polite">
            {selectedPreset && (
              <span
                className={
                  presetHasChanges
                    ? "presetDirty"
                    : presetSettingsMatch
                      ? "presetSaved"
                      : "presetPending"
                }
              >
                {presetStatus}
              </span>
            )}
            {presetMessage && <span>{presetMessage}</span>}
          </div>

          <div className="presetRow">
            <select
              aria-label="保存済みプリセット"
              value={selectedPresetId}
              onChange={(event) => selectPreset(event.target.value)}
            >
              <option value="">新しいプリセット</option>
              {customPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button
              className="presetApply"
              disabled={!selectedPreset}
              onClick={() => {
                if (!selectedPreset) return;
                onApplyPreset(selectedPreset);
                setAppliedPresetId(selectedPreset.id);
                setIncludeWindowSize(Boolean(selectedPreset.windowSize));
                setPresetMessage("適用しました");
              }}
            >
              適用
            </button>
          </div>

          <div className="presetRow">
            <input
              type="text"
              value={presetName}
              maxLength={24}
              placeholder="プリセット名"
              aria-label="プリセット名"
              onChange={(event) => {
                setPresetName(event.target.value);
                setPresetMessage("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void savePreset();
              }}
            />
            <button
              className="presetSave"
              disabled={
                !normalizedPresetName ||
                (!selectedPreset && customPresets.length >= MAX_CUSTOM_PRESETS)
              }
              onClick={() => void savePreset()}
            >
              {selectedPreset ? "上書き" : "保存"}
            </button>
          </div>

          <label className="presetSizeOption">
            <input
              type="checkbox"
              checked={includeWindowSize}
              onChange={(event) => {
                setIncludeWindowSize(event.target.checked);
                setPresetMessage("");
              }}
            />
            <span>ウィンドウサイズも含める</span>
            {includeWindowSize && selectedPreset?.windowSize && (
              <small>
                {selectedPreset.windowSize.width}×
                {selectedPreset.windowSize.height}
              </small>
            )}
          </label>

          <div className="presetActions">
            <span>{customPresets.length}/{MAX_CUSTOM_PRESETS}</span>
            <input
              ref={importInputRef}
              className="presetFileInput"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importPresets(file);
              }}
            />
            <button
              disabled={customPresets.length === 0}
              onClick={exportPresets}
            >
              書き出し
            </button>
            <button
              disabled={customPresets.length >= MAX_CUSTOM_PRESETS}
              onClick={() => importInputRef.current?.click()}
            >
              読み込み
            </button>
            <button
              disabled={!selectedPreset}
              onClick={() => {
                setSelectedPresetId("");
                setAppliedPresetId("");
                setPresetName("");
                setIncludeWindowSize(false);
                setPresetMessage("");
              }}
            >
              新規
            </button>
            <button
              className="presetDelete"
              disabled={!selectedPreset}
              onClick={() => {
                if (!selectedPreset) return;
                onDeletePreset(selectedPreset.id);
                setSelectedPresetId("");
                setAppliedPresetId("");
                setPresetName("");
                setIncludeWindowSize(false);
                setPresetMessage("削除しました");
              }}
            >
              削除
            </button>
          </div>
        </SettingsSection>

        <SettingsSection title="スタイル">

          <FontSelect
            label="英数字フォント"
            value={settings.latinFont}
            fonts={fontCatalog.latin}
            presets={[[APP_FONT_SEGOE, "Windows標準（Segoe UI）"]]}
            onSelect={(latinFont) => update({ latinFont })}
          />

          <FontSelect
            label="日本語フォント"
            value={settings.japaneseFont}
            fonts={fontCatalog.japanese}
            presets={[
              [APP_FONT_NOTO, "アプリ標準（Noto Sans JP）"],
              [APP_FONT_ZEN, "アプリ標準（Zen Kaku）"],
            ]}
            onSelect={(japaneseFont) => update({ japaneseFont })}
          />

          <OptionPicker
            label="ジャケット"
            value={settings.coverShape}
            options={[
              ["rounded", "角丸"],
              ["square", "四角"],
              ["circle", "丸"],
              ["disc", "ディスク"],
            ]}
            onSelect={(coverShape) => update({ coverShape })}
          />

          <label className="settingRow">
            <span>帯の太さ</span>
            <input
              type="range"
              min="60"
              max="100"
              step="5"
              value={settings.bandThickness}
              onChange={(event) =>
                update({ bandThickness: Number(event.target.value) })
              }
            />
            <output>{settings.bandThickness}%</output>
          </label>

          <OptionPicker
            label="帯の形"
            value={settings.bandShape}
            options={[
              ["rounded", "角丸"],
              ["square", "四角"],
            ]}
            onSelect={(bandShape) => update({ bandShape })}
          />

          <OptionPicker
            label="帯の右端"
            value={settings.bandEdge}
            options={[
              ["solid", "通常"],
              ["fade", "フェード"],
            ]}
            onSelect={(bandEdge) => update({ bandEdge })}
          />

          <label
            className={`settingRow ${
              settings.bandEdge === "fade" ? "" : "settingDisabled"
            }`}
          >
            <span>フェード長さ</span>
            <input
              type="range"
              min="15"
              max="60"
              step="5"
              value={settings.fadeLength}
              disabled={settings.bandEdge !== "fade"}
              onChange={(event) =>
                update({ fadeLength: Number(event.target.value) })
              }
            />
            <output>{settings.fadeLength}%</output>
          </label>

          <label
            className={`settingRow ${
              settings.bandEdge === "fade" ? "" : "settingDisabled"
            }`}
          >
            <span>フェード強さ</span>
            <input
              type="range"
              min="40"
              max="100"
              step="5"
              value={settings.fadeStrength}
              disabled={settings.bandEdge !== "fade"}
              onChange={(event) =>
                update({ fadeStrength: Number(event.target.value) })
              }
            />
            <output>{settings.fadeStrength}%</output>
          </label>

          <OptionPicker
            label="背景"
            value={settings.backgroundStyle}
            options={[
              ["dark", "ダーク"],
              ["vivid", "カラー"],
              ["frost", "フロスト"],
              ["glass", "ミラー"],
            ]}
            onSelect={(backgroundStyle) => update({ backgroundStyle })}
          />

          <label
            className={`settingRow ${
              settings.backgroundStyle === "vivid" ? "" : "settingDisabled"
            }`}
          >
            <span>カラー彩度</span>
            <input
              type="range"
              min="100"
              max="160"
              step="5"
              value={settings.colorSaturation}
              disabled={settings.backgroundStyle !== "vivid"}
              onChange={(event) =>
                update({ colorSaturation: Number(event.target.value) })
              }
            />
            <output>{settings.colorSaturation}%</output>
          </label>

          <label
            className={`settingRow ${
              settings.backgroundStyle === "glass" ? "" : "settingDisabled"
            }`}
          >
            <span>ミラー反射</span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={settings.glassReflection}
              disabled={settings.backgroundStyle !== "glass"}
              onChange={(event) =>
                update({ glassReflection: Number(event.target.value) })
              }
            />
            <output>{settings.glassReflection}%</output>
          </label>

        </SettingsSection>

        <SettingsSection title="動きと表示">

          <OptionPicker
            label="切り替え"
            value={settings.transitionMode}
            options={[
              ["focus", "フォーカス"],
              ["slide", "スライド"],
            ]}
            onSelect={(transitionMode) => update({ transitionMode })}
          />

          <label className="settingRow">
            <span>
              {settings.transitionMode === "slide" ? "スライド時間" : "ズーム時間"}
            </span>
            <input
              type="range"
              min="400"
              max={selectedTransitionMax}
              step="100"
              value={selectedTransitionMs}
              onChange={(event) => {
                const durationMs = Number(event.target.value);
                update(
                  settings.transitionMode === "slide"
                    ? { slideTransitionMs: durationMs }
                    : { focusTransitionMs: durationMs }
                );
              }}
            />
            <output>{(selectedTransitionMs / 1000).toFixed(1)}秒</output>
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
              min="50"
              max="140"
              step="5"
              value={settings.textScale}
              onChange={(event) =>
                update({ textScale: Number(event.target.value) })
              }
            />
            <output>{settings.textScale}%</output>
          </label>

          <label className="settingRow">
            <span>アーティスト濃さ</span>
            <input
              type="range"
              min="50"
              max="100"
              step="5"
              value={settings.artistOpacity}
              onChange={(event) =>
                update({ artistOpacity: Number(event.target.value) })
              }
            />
            <output>{settings.artistOpacity}%</output>
          </label>

          <OptionPicker
            label="文字配置"
            value={settings.textAlignment}
            options={[
              ["left", "左揃え"],
              ["center", "中央揃え"],
            ]}
            onSelect={(textAlignment) => update({ textAlignment })}
          />

          <OptionPicker
            label="再生時間バー"
            value={settings.progressBarEnabled ? "show" : "hide"}
            options={[
              ["hide", "隠す"],
              ["show", "表示"],
            ]}
            onSelect={(value) =>
              update({ progressBarEnabled: value === "show" })
            }
          />

          <OptionPicker
            label="ディスク回転"
            value={settings.discSpinEnabled ? "on" : "off"}
            options={[
              ["on", "回す"],
              ["off", "止める"],
            ]}
            onSelect={(value) => update({ discSpinEnabled: value === "on" })}
          />

          <label
            className={`settingRow ${
              settings.discSpinEnabled &&
              settings.coverShape === "disc"
                ? ""
                : "settingDisabled"
            }`}
          >
            <span>回転速度</span>
            <input
              type="range"
              min="4"
              max="30"
              step="1"
              value={settings.discSpinSeconds}
              disabled={
                !settings.discSpinEnabled ||
                settings.coverShape !== "disc"
              }
              onChange={(event) =>
                update({ discSpinSeconds: Number(event.target.value) })
              }
            />
            <output>{settings.discSpinSeconds}秒/周</output>
          </label>
        </SettingsSection>

        <button
          className="settingsReset"
          onClick={() => {
            setPresetMessage("");
            onReset();
          }}
        >
          初期値に戻す
        </button>
      </div>
    </main>
  );
}

function SettingsSection({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section
      className={`settingsSection ${className} ${open ? "" : "sectionCollapsed"}`}
    >
      <button
        className="settingsSectionToggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <h2>{title}</h2>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && <div className="settingsSectionContent">{children}</div>}
    </section>
  );
}

function FontSelect({
  label,
  value,
  fonts,
  presets,
  onSelect,
}: {
  label: string;
  value: string;
  fonts: string[];
  presets: ReadonlyArray<readonly [string, string]>;
  onSelect: (value: string) => void;
}) {
  const isPresetFont = presets.some(([font]) => font === value);
  const missingSelectedFont = !isPresetFont && !fonts.includes(value);

  return (
    <label className="settingRow fontSelectRow">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onSelect(event.target.value)}
        style={{ fontFamily: cssFontFamily(value) }}
      >
        {presets.map(([font, optionLabel]) => (
          <option key={font} value={font}>
            {optionLabel}
          </option>
        ))}
        {missingSelectedFont && <option value={value}>{value}（現在の設定）</option>}
        {fonts.map((font) => (
          <option key={font} value={font} style={{ fontFamily: font }}>
            {font}
          </option>
        ))}
      </select>
    </label>
  );
}

function OptionPicker<T extends string>({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="settingRow optionRow">
      <span>{label}</span>
      <div className="optionPicker">
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            type="button"
            className={value === optionValue ? "active" : ""}
            aria-pressed={value === optionValue}
            onClick={() => onSelect(optionValue)}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

function TrackLayer({
  track,
  phase,
  marqueeRestartKey,
  progressBarEnabled,
  backgroundStyle,
  blurPx,
  colorSaturation,
}: {
  track: Track;
  phase: TrackLayerPhase;
  marqueeRestartKey: string;
  progressBarEnabled: boolean;
  backgroundStyle: BackgroundStyle;
  blurPx: number;
  colorSaturation: number;
}) {
  const artworkAnalysis = useArtworkAnalysis(track.image_url);
  const textInfoRef = useRef<HTMLDivElement>(null);
  const [textStackHeight, setTextStackHeight] = useState(0);

  useLayoutEffect(() => {
    const textInfo = textInfoRef.current;
    if (!textInfo) return;

    const measure = () => setTextStackHeight(textInfo.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(textInfo);
    return () => observer.disconnect();
  }, [track.title, track.artists]);

  const adaptiveStyle = createAdaptiveArtworkStyle(
    artworkAnalysis,
    backgroundStyle,
    blurPx,
    colorSaturation
  );
  const layerStyle = {
    ...adaptiveStyle,
    "--text-stack-half-height": `${Math.max(textStackHeight / 2, 14).toFixed(1)}px`,
  } as React.CSSProperties;

  return (
    <div
      className={`trackLayer ${phase}`}
      aria-hidden={phase === "leaving"}
      style={layerStyle}
    >
      {track.image_url && (
        <div
          className="ambientCover"
          style={{ backgroundImage: `url("${track.image_url}")` }}
        />
      )}

      <div className="darkOverlay" />

      <div className={`cover ${track.image_url ? "" : "empty"}`}>
        <div className="discSurface">
          {track.image_url ? (
            <img
              className="coverArt"
              src={track.image_url}
              alt=""
              draggable={false}
              decoding="async"
            />
          ) : (
            <span className="emptyCoverMark">♫</span>
          )}
        </div>
      </div>

      <div className="meta">
        <div className="trackInfoStack">
          <div ref={textInfoRef} className="trackInfoText">
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
          {progressBarEnabled && <ProgressBar initialTrack={track} />}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ initialTrack }: { initialTrack: Track }) {
  const [snapshot, setSnapshot] = useState<
    PlaybackProgress & { receivedAt: number }
  >({
    track_key: initialTrack.track_key,
    duration_ms: initialTrack.duration_ms,
    progress_ms: initialTrack.progress_ms,
    is_playing: initialTrack.is_playing,
    receivedAt: performance.now(),
  });
  const [, setClock] = useState(0);

  useEffect(() => {
    setSnapshot({
      track_key: initialTrack.track_key,
      duration_ms: initialTrack.duration_ms,
      progress_ms: initialTrack.progress_ms,
      is_playing: initialTrack.is_playing,
      receivedAt: performance.now(),
    });
  }, [
    initialTrack.track_key,
    initialTrack.duration_ms,
    initialTrack.progress_ms,
    initialTrack.is_playing,
  ]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void listen<PlaybackProgress | null>(
      "media-session-progress",
      (event) => {
        const progress = event.payload;
        if (
          !disposed &&
          progress?.track_key === initialTrack.track_key
        ) {
          const receivedAt = performance.now();
          setSnapshot((current) => {
            let progressMs = progress.progress_ms;

            if (
              progress.is_playing &&
              current.is_playing &&
              current.track_key === progress.track_key &&
              progressMs !== null &&
              current.progress_ms !== null
            ) {
              const durationMs =
                progress.duration_ms ?? current.duration_ms ?? Number.MAX_SAFE_INTEGER;
              const projectedProgress = clamp(
                current.progress_ms + (receivedAt - current.receivedAt),
                0,
                durationMs
              );

              if (
                Math.abs(progressMs - projectedProgress) <
                PROGRESS_SEEK_THRESHOLD_MS
              ) {
                progressMs = Math.max(progressMs, projectedProgress);
              }
            }

            return { ...progress, progress_ms: progressMs, receivedAt };
          });
        }
      }
    ).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [initialTrack.track_key]);

  useEffect(() => {
    if (!snapshot.is_playing) return;
    let animationFrame = 0;
    const updateClock = (time: number) => {
      setClock(time);
      animationFrame = window.requestAnimationFrame(updateClock);
    };
    animationFrame = window.requestAnimationFrame(updateClock);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [snapshot.is_playing]);

  const durationMs = snapshot.duration_ms ?? 0;
  if (durationMs <= 0 || snapshot.progress_ms === null) return null;

  const elapsedSinceUpdate = snapshot.is_playing
    ? performance.now() - snapshot.receivedAt
    : 0;
  const progressMs = clamp(
    snapshot.progress_ms + elapsedSinceUpdate,
    0,
    durationMs
  );
  const progressRatio = progressMs / durationMs;

  return (
    <div
      className="progressBar"
      role="progressbar"
      aria-label="再生位置"
      aria-valuemin={0}
      aria-valuemax={durationMs}
      aria-valuenow={Math.round(progressMs)}
      style={{ "--progress-ratio": progressRatio } as React.CSSProperties}
    >
      <div className="progressBarTrack" />
      <div className="progressBarFill" />
      <div className="progressBarThumb" />
    </div>
  );
}

function mixColor(
  source: ArtworkAnalysis["accent"],
  target: ArtworkAnalysis["accent"],
  amount: number
) {
  return {
    red: Math.round(source.red + (target.red - source.red) * amount),
    green: Math.round(source.green + (target.green - source.green) * amount),
    blue: Math.round(source.blue + (target.blue - source.blue) * amount),
  };
}

function rgbChannels(color: ArtworkAnalysis["accent"]) {
  return `${color.red} ${color.green} ${color.blue}`;
}

function createAdaptiveArtworkStyle(
  analysis: ArtworkAnalysis | null,
  backgroundStyle: BackgroundStyle,
  blurPx: number,
  colorSaturation: number
) {
  const sourceLuminance = analysis?.luminance ?? 0.35;
  const colorStrength = clamp((colorSaturation - 100) / 60, 0, 1);
  const effectiveLuminance =
    backgroundStyle === "frost"
      ? clamp(0.62 + sourceLuminance * 0.28, 0, 1)
      : backgroundStyle === "glass"
        ? clamp(0.2 + sourceLuminance * 0.62, 0, 1)
      : backgroundStyle === "vivid"
        ? clamp(sourceLuminance * (0.94 - colorStrength * 0.12), 0, 1)
        : clamp(sourceLuminance * 0.55, 0, 1);
  const useDarkForeground = effectiveLuminance >= 0.58;
  const detailFactor = 1 - clamp(blurPx / 24, 0, 1);
  const contrastRisk = useDarkForeground
    ? 1 - effectiveLuminance
    : effectiveLuminance;
  const modeShadowBase =
    backgroundStyle === "vivid"
      ? 0.3 + colorStrength * 0.08
      : backgroundStyle === "frost"
        ? 0.2
        : backgroundStyle === "glass"
          ? 0.34
          : 0.3;
  const shadowAlpha = clamp(
    modeShadowBase + contrastRisk * 0.28 + detailFactor * 0.2,
    0.2,
    0.78
  );
  const shadowBlur = 1.8 + detailFactor * 2.6;
  const accent = analysis?.accent ?? { red: 210, green: 218, blue: 226 };
  const accentTarget = useDarkForeground
    ? { red: 8, green: 12, blue: 16 }
    : { red: 255, green: 255, blue: 255 };
  const modeAccentMix =
    backgroundStyle === "vivid"
      ? 0.22 + colorStrength * 0.1
      : backgroundStyle === "frost"
        ? 0.24
        : backgroundStyle === "glass"
          ? 0.28
          : 0.2;
  const progressAccent = mixColor(
    accent,
    accentTarget,
    clamp(modeAccentMix + contrastRisk * 0.16, 0.18, 0.48)
  );
  const foregroundChannels = useDarkForeground ? "18 24 30" : "255 255 255";
  const shadowChannels = useDarkForeground ? "255 255 255" : "0 0 0";
  const trackAlpha = clamp(
    (backgroundStyle === "vivid"
      ? 0.24 + colorStrength * 0.06
      : backgroundStyle === "glass"
        ? 0.28
        : 0.22) + detailFactor * 0.13,
    0.2,
    0.45
  );

  return {
    "--title-color": `rgb(${foregroundChannels} / 0.98)`,
    "--artist-color-rgb": foregroundChannels,
    "--text-shadow-color": `rgb(${shadowChannels} / ${shadowAlpha.toFixed(2)})`,
    "--text-shadow-blur": `${shadowBlur.toFixed(1)}px`,
    "--progress-accent": `rgb(${rgbChannels(progressAccent)})`,
    "--progress-track-color": `rgb(${foregroundChannels} / ${trackAlpha.toFixed(2)})`,
    "--progress-glow-color": `rgb(${rgbChannels(progressAccent)} / ${clamp(
      0.36 + detailFactor * 0.24,
      0.36,
      0.6
    ).toFixed(2)})`,
    "--progress-glow-blur": `${(3 + detailFactor * 3).toFixed(1)}px`,
  } as React.CSSProperties;
}

function useArtworkAnalysis(imageUrl: string | null) {
  const [analysis, setAnalysis] = useState<ArtworkAnalysis | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    if (!imageUrl) return;

    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = 20;
      canvas.height = 20;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;

      try {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height
        ).data;
        const buckets = new Map<
          string,
          { red: number; green: number; blue: number; weight: number }
        >();
        let localLuminanceTotal = 0;
        let localLuminanceWeight = 0;

        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] < 160) continue;
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          const alphaWeight = pixels[index + 3] / 255;
          const pixelNumber = index / 4;
          const sampleX = pixelNumber % canvas.width;
          const sampleY = Math.floor(pixelNumber / canvas.width);
          if (
            sampleX >= canvas.width * 0.08 &&
            sampleX <= canvas.width * 0.92 &&
            sampleY >= canvas.height * 0.38 &&
            sampleY <= canvas.height * 0.62
          ) {
            localLuminanceTotal +=
              ((red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255) *
              alphaWeight;
            localLuminanceWeight += alphaWeight;
          }
          const maximum = Math.max(red, green, blue);
          const minimum = Math.min(red, green, blue);
          const lightness = (maximum + minimum) / 510;
          if (lightness < 0.1 || lightness > 0.92) continue;
          const saturation = (maximum - minimum) / 255;
          const weight = 0.3 + saturation * 1.7;
          const key = `${red >> 5}-${green >> 5}-${blue >> 5}`;
          const bucket = buckets.get(key) ?? {
            red: 0,
            green: 0,
            blue: 0,
            weight: 0,
          };
          bucket.red += red * weight;
          bucket.green += green * weight;
          bucket.blue += blue * weight;
          bucket.weight += weight;
          buckets.set(key, bucket);
        }

        const dominant = [...buckets.values()].sort(
          (left, right) => right.weight - left.weight
        )[0];
        let red = dominant ? dominant.red / dominant.weight : 180;
        let green = dominant ? dominant.green / dominant.weight : 188;
        let blue = dominant ? dominant.blue / dominant.weight : 196;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        if (luminance < 92) {
          red += (255 - red) * 0.28;
          green += (255 - green) * 0.28;
          blue += (255 - blue) * 0.28;
        } else if (luminance > 205) {
          red *= 0.78;
          green *= 0.78;
          blue *= 0.78;
        }
        if (!cancelled) {
          setAnalysis({
            accent: {
              red: Math.round(red),
              green: Math.round(green),
              blue: Math.round(blue),
            },
            luminance:
              localLuminanceWeight > 0
                ? localLuminanceTotal / localLuminanceWeight
                : 0.35,
          });
        }
      } catch (error) {
        console.error("ジャケットのアクセント色を取得できませんでした", error);
      }
    };
    image.src = imageUrl;

    return () => {
      cancelled = true;
      image.onload = null;
    };
  }, [imageUrl]);

  return analysis;
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
      className={`marqueeViewport ${className}Viewport ${
        shouldScroll ? "isScrolling" : ""
      }`}
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
          <ScriptedText text={text} />
        </span>
        {shouldScroll && (
          <>
            <span className="marqueeSpace" aria-hidden="true">
              &nbsp;
            </span>
            <span className={className} aria-hidden="true">
              <ScriptedText text={text} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}

type TextScript = "latin" | "japanese";

const JAPANESE_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆ヵヶー]/u;

function ScriptedText({ text }: { text: string }) {
  const runs: Array<{ script: TextScript; text: string }> = [];

  for (const character of text) {
    const explicitScript: TextScript | null = JAPANESE_CHARACTER.test(character)
      ? "japanese"
      : /[\p{Letter}\p{Number}]/u.test(character)
        ? "latin"
        : null;
    const previous = runs[runs.length - 1];
    const script = explicitScript ?? previous?.script ?? "latin";
    if (previous?.script === script) {
      previous.text += character;
    } else {
      runs.push({ script, text: character });
    }
  }

  return (
    <>
      {runs.map((run, index) => (
        <span key={`${index}-${run.script}`} className={`script-${run.script}`}>
          {run.text}
        </span>
      ))}
    </>
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
