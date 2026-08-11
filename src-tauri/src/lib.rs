use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
const REDIRECT: &str = "http://127.0.0.1:43821/callback";
#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}
#[derive(Serialize)]
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
fn token_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("spotify-now-playing-widget");
    let _ = fs::create_dir_all(&p);
    p.push("tokens.json");
    p
}
fn load() -> Result<Tokens, String> {
    serde_json::from_str(&fs::read_to_string(token_path()).map_err(|_| "not connected")?)
        .map_err(|e| e.to_string())
}
fn save(t: &Tokens) -> Result<(), String> {
    fs::write(token_path(), serde_json::to_string(t).unwrap()).map_err(|e| e.to_string())
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
#[tauri::command]
async fn spotify_login(client_id: String) -> Result<(), String> {
    let verifier: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    let auth=format!("https://accounts.spotify.com/authorize?client_id={}&response_type=code&redirect_uri={}&scope=user-read-currently-playing&code_challenge_method=S256&code_challenge={}&state={}",urlencoding::encode(&client_id),urlencoding::encode(REDIRECT),challenge,state);
    let listener = TcpListener::bind("127.0.0.1:43821")
        .await
        .map_err(|e| format!("callback port: {e}"))?;
    open::that(auth).map_err(|e| e.to_string())?;
    let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
    let mut buf = [0u8; 4096];
    let n = socket.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req.split_whitespace().nth(1).ok_or("invalid callback")?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let ok = params.get("state") == Some(&state);
    let code = params.get("code").cloned();
    let body = if ok && code.is_some() {
        "<h2>Connected. You can close this window.</h2>"
    } else {
        "<h2>Spotify connection failed.</h2>"
    };
    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
    let _ = socket.write_all(response.as_bytes()).await;
    if !ok {
        return Err("state mismatch".into());
    }
    let form = [
        ("client_id", client_id.as_str()),
        ("grant_type", "authorization_code"),
        ("code", code.as_deref().unwrap()),
        ("redirect_uri", REDIRECT),
        ("code_verifier", verifier.as_str()),
    ];
    let v: reqwest::Response = reqwest::Client::new()
        .post("https://accounts.spotify.com/api/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = v.json().await.map_err(|e| e.to_string())?;
    let t = Tokens {
        client_id,
        access_token: j["access_token"]
            .as_str()
            .ok_or_else(|| j.to_string())?
            .into(),
        refresh_token: j["refresh_token"]
            .as_str()
            .ok_or("missing refresh token")?
            .into(),
        expires_at: now() + j["expires_in"].as_u64().unwrap_or(3600) - 60,
    };
    save(&t)
}
async fn valid_token() -> Result<Tokens, String> {
    let mut t = load()?;
    if now() < t.expires_at {
        return Ok(t);
    }
    let form = [
        ("client_id", t.client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", t.refresh_token.as_str()),
    ];
    let j: serde_json::Value = reqwest::Client::new()
        .post("https://accounts.spotify.com/api/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    t.access_token = j["access_token"]
        .as_str()
        .ok_or_else(|| j.to_string())?
        .into();
    t.expires_at = now() + j["expires_in"].as_u64().unwrap_or(3600) - 60;
    save(&t)?;
    Ok(t)
}
#[tauri::command]
async fn now_playing() -> Result<Option<Track>, String> {
    let t = valid_token().await?;
    let r = reqwest::Client::new()
        .get("https://api.spotify.com/v1/me/player/currently-playing")
        .bearer_auth(t.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if r.status().as_u16() == 204 {
        return Ok(None);
    }
    if !r.status().is_success() {
        return Err(format!("Spotify API: {}", r.status()));
    }
    let j: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    let item = &j["item"];
    let artists = item["artists"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["name"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let title = item["name"].as_str().unwrap_or("Unknown").to_string();
    let spotify_url = item["external_urls"]["spotify"]
        .as_str()
        .map(str::to_string);
    let track_key = item["uri"]
        .as_str()
        .or(spotify_url.as_deref())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{title}\u{1f}{artists}"));
    let image_url = item["album"]["images"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|x| x["url"].as_str())
        .or_else(|| {
            item["images"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|x| x["url"].as_str())
        })
        .map(str::to_string);

    Ok(Some(Track {
        track_key,
        title,
        artists,
        image_url,
        is_playing: j["is_playing"].as_bool().unwrap_or(false),
        spotify_url,
        duration_ms: item["duration_ms"].as_u64(),
        progress_ms: j["progress_ms"].as_u64(),
    }))
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::MacosLauncher;
                #[cfg(not(debug_assertions))]
                use tauri_plugin_autostart::ManagerExt;

                app.handle().plugin(tauri_plugin_autostart::init(
                    MacosLauncher::LaunchAgent,
                    None,
                ))?;

                #[cfg(not(debug_assertions))]
                if let Err(error) = app.autolaunch().enable() {
                    eprintln!("failed to enable autostart: {error}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![spotify_login, now_playing])
        .run(tauri::generate_context!())
        .expect("error running app");
}
