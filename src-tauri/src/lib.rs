use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use windows::{
    Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    },
    Storage::Streams::DataReader,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

const MEDIA_SESSION_POLL_INTERVAL: Duration = Duration::from_millis(200);
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

fn publish_track(app: &AppHandle, current: &Arc<Mutex<Option<Track>>>, track: Option<Track>) {
    *current.lock().unwrap_or_else(|error| error.into_inner()) = track.clone();
    let _ = app.emit("media-session-track", track);
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
            loop {
                match read_track(&manager, previous.as_ref()) {
                    Ok(next) => {
                        if visible_track_changed(previous.as_ref(), next.as_ref()) {
                            publish_track(&app, &current, next.clone());
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
        .invoke_handler(tauri::generate_handler![now_playing])
        .run(tauri::generate_context!())
        .expect("error running app");
}
