use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use windows::{
    Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    },
    Storage::Streams::DataReader,
    Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, DWRITE_FACTORY_TYPE_SHARED,
        DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_NORMAL,
    },
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

const MEDIA_SESSION_POLL_INTERVAL: Duration = Duration::from_millis(200);
const PROGRESS_PUBLISH_INTERVAL: Duration = Duration::from_secs(1);
const MEDIA_SESSION_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const MAX_THUMBNAIL_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Track {
    track_key: String,
    title: String,
    artists: String,
    image_url: Option<String>,
    is_playing: bool,
    spotify_url: Option<String>,
    duration_ms: Option<u64>,
    progress_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct PlaybackProgress {
    track_key: String,
    duration_ms: Option<u64>,
    progress_ms: Option<u64>,
    is_playing: bool,
}

impl From<&Track> for PlaybackProgress {
    fn from(track: &Track) -> Self {
        Self {
            track_key: track.track_key.clone(),
            duration_ms: track.duration_ms,
            progress_ms: track.progress_ms,
            is_playing: track.is_playing,
        }
    }
}

#[derive(Serialize)]
struct InstalledFontCatalog {
    latin: Vec<String>,
    japanese: Vec<String>,
}

#[derive(Clone, Default)]
struct MediaSessionState {
    current: Arc<Mutex<Option<Track>>>,
}

fn spotify_session(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> windows::core::Result<Option<GlobalSystemMediaTransportControlsSession>> {
    let sessions = manager.GetSessions()?;
    for index in 0..sessions.Size()? {
        let session = sessions.GetAt(index)?;
        let source = session.SourceAppUserModelId()?.to_string().to_lowercase();
        if source.contains("spotify") {
            return Ok(Some(session));
        }
    }

    Ok(None)
}

fn ticks_to_ms(ticks: i64) -> Option<u64> {
    u64::try_from(ticks).ok().map(|value| value / 10_000)
}

fn thumbnail_data_url(
    session_properties: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    let reference = session_properties.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?.min(MAX_THUMBNAIL_BYTES);
    if size == 0 {
        return None;
    }

    let input = stream.GetInputStreamAt(0).ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut bytes = vec![0; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let content_type = stream
        .ContentType()
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let _ = reader.Close();

    Some(format!(
        "data:{content_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

fn read_track(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
    previous: Option<&Track>,
) -> windows::core::Result<Option<Track>> {
    let Some(session) = spotify_session(manager)? else {
        return Ok(None);
    };

    let properties = session.TryGetMediaPropertiesAsync()?.get()?;
    let title = properties.Title()?.to_string();
    if title.trim().is_empty() {
        return Ok(None);
    }

    let artists = properties.Artist()?.to_string();
    let album = properties.AlbumTitle()?.to_string();
    let source = session.SourceAppUserModelId()?.to_string();
    let track_key = format!("{source}\u{1f}{title}\u{1f}{artists}\u{1f}{album}");
    let image_url = if previous
        .filter(|track| track.track_key == track_key)
        .and_then(|track| track.image_url.as_ref())
        .is_some()
    {
        previous.and_then(|track| track.image_url.clone())
    } else {
        thumbnail_data_url(&properties)
    };

    let is_playing = session.GetPlaybackInfo()?.PlaybackStatus()?
        == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
    let timeline = session.GetTimelineProperties().ok();
    let progress_ms = timeline
        .as_ref()
        .and_then(|value| value.Position().ok())
        .and_then(|value| ticks_to_ms(value.Duration));
    let duration_ms = timeline.as_ref().and_then(|value| {
        let start = value.StartTime().ok()?.Duration;
        let end = value.EndTime().ok()?.Duration;
        ticks_to_ms(end.saturating_sub(start))
    });

    Ok(Some(Track {
        track_key,
        title,
        artists,
        image_url,
        is_playing,
        spotify_url: None,
        duration_ms,
        progress_ms,
    }))
}

fn visible_track_changed(previous: Option<&Track>, next: Option<&Track>) -> bool {
    match (previous, next) {
        (None, None) => false,
        (Some(previous), Some(next)) => {
            previous.track_key != next.track_key
                || previous.title != next.title
                || previous.artists != next.artists
                || previous.image_url != next.image_url
                || previous.is_playing != next.is_playing
        }
        _ => true,
    }
}

struct WinRtApartment;

impl WinRtApartment {
    fn initialize() -> windows::core::Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self)
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn start_media_session_monitor(app: AppHandle, current: Arc<Mutex<Option<Track>>>) {
    thread::spawn(move || {
        let _apartment = match WinRtApartment::initialize() {
            Ok(apartment) => apartment,
            Err(error) => {
                eprintln!("Windows Runtime initialization failed: {error}");
                return;
            }
        };

        loop {
            let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
                .and_then(|operation| operation.get())
            {
                Ok(manager) => manager,
                Err(error) => {
                    eprintln!("Windows media session access failed: {error}");
                    thread::sleep(MEDIA_SESSION_RETRY_INTERVAL);
                    continue;
                }
            };

            let mut previous: Option<Track> = None;
            let mut last_progress_publish = Instant::now()
                .checked_sub(PROGRESS_PUBLISH_INTERVAL)
                .unwrap();
            loop {
                match read_track(&manager, previous.as_ref()) {
                    Ok(next) => {
                        let visible_changed =
                            visible_track_changed(previous.as_ref(), next.as_ref());
                        *current.lock().unwrap_or_else(|error| error.into_inner()) = next.clone();

                        if visible_changed {
                            let _ = app.emit("media-session-track", next.clone());
                        }

                        if visible_changed
                            || last_progress_publish.elapsed() >= PROGRESS_PUBLISH_INTERVAL
                        {
                            let progress = next.as_ref().map(PlaybackProgress::from);
                            let _ = app.emit("media-session-progress", progress);
                            last_progress_publish = Instant::now();
                        }
                        previous = next;
                        thread::sleep(MEDIA_SESSION_POLL_INTERVAL);
                    }
                    Err(error) => {
                        eprintln!("Windows media session read failed: {error}");
                        thread::sleep(MEDIA_SESSION_RETRY_INTERVAL);
                        break;
                    }
                }
            }
        }
    });
}

#[tauri::command]
fn now_playing(state: State<'_, MediaSessionState>) -> Option<Track> {
    state
        .current
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

fn direct_write_font_catalog() -> windows::core::Result<InstalledFontCatalog> {
    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        let mut collection = None;
        factory.GetSystemFontCollection(&mut collection, false)?;
        let collection = collection.expect("DirectWrite returned no system font collection");
        let mut latin = Vec::new();
        let mut japanese = Vec::new();

        for index in 0..collection.GetFontFamilyCount() {
            let family = collection.GetFontFamily(index)?;
            let names = family.GetFamilyNames()?;
            let name_length = names.GetStringLength(0)? as usize;
            let mut buffer = vec![0u16; name_length + 1];
            names.GetString(0, &mut buffer)?;
            let name = String::from_utf16_lossy(&buffer[..name_length]);
            if name.trim().is_empty() {
                continue;
            }

            let matching = family.GetFirstMatchingFont(
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
            )?;
            let supports_latin = matching.HasCharacter('A' as u32)?.as_bool()
                && matching.HasCharacter('a' as u32)?.as_bool()
                && matching.HasCharacter('0' as u32)?.as_bool();
            let supports_japanese = matching.HasCharacter('あ' as u32)?.as_bool()
                && matching.HasCharacter('ア' as u32)?.as_bool()
                && matching.HasCharacter('日' as u32)?.as_bool();

            if supports_japanese {
                japanese.push(name.clone());
            }
            if supports_latin && !supports_japanese {
                latin.push(name);
            }
        }

        latin.sort_by_key(|name| name.to_lowercase());
        latin.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        japanese.sort_by_key(|name| name.to_lowercase());
        japanese.dedup_by(|left, right| left.eq_ignore_ascii_case(right));

        Ok(InstalledFontCatalog { latin, japanese })
    }
}

#[tauri::command]
fn installed_fonts() -> Result<InstalledFontCatalog, String> {
    direct_write_font_catalog().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(key: &str, is_playing: bool) -> Track {
        Track {
            track_key: key.to_string(),
            title: "Title".to_string(),
            artists: "Artist".to_string(),
            image_url: Some("data:image/png;base64,abc".to_string()),
            is_playing,
            spotify_url: None,
            duration_ms: Some(180_000),
            progress_ms: Some(10_000),
        }
    }

    #[test]
    fn progress_only_change_does_not_repaint_the_widget() {
        let previous = track("same", true);
        let mut next = previous.clone();
        next.progress_ms = Some(11_000);
        assert!(!visible_track_changed(Some(&previous), Some(&next)));
    }

    #[test]
    fn track_and_playback_changes_are_published() {
        assert!(visible_track_changed(
            Some(&track("first", true)),
            Some(&track("second", true))
        ));
        assert!(visible_track_changed(
            Some(&track("same", true)),
            Some(&track("same", false))
        ));
    }

    #[test]
    fn installed_font_catalog_contains_system_fonts() {
        let catalog = direct_write_font_catalog().expect("system fonts should be enumerable");
        assert!(!catalog.latin.is_empty());
        assert!(!catalog.japanese.is_empty());
        assert!(catalog.latin.iter().all(|latin_name| !catalog
            .japanese
            .iter()
            .any(|japanese_name| latin_name.eq_ignore_ascii_case(japanese_name))));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let media_state = MediaSessionState::default();
    let monitor_state = media_state.current.clone();

    tauri::Builder::default()
        .manage(media_state)
        .setup(move |app| {
            start_media_session_monitor(app.handle().clone(), monitor_state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![now_playing, installed_fonts])
        .run(tauri::generate_context!())
        .expect("error running app");
}
