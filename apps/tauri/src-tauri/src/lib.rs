use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_notification::NotificationExt;

struct AppState {
  data_dir: PathBuf,
  fired: Mutex<HashSet<String>>,
}

#[cfg(windows)]
fn set_taskbar_hidden(window: &WebviewWindow) {
  use std::ffi::c_void;

  const GWL_EXSTYLE: i32 = -20;
  const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
  const WS_EX_APPWINDOW: isize = 0x0004_0000;
  const SWP_NOSIZE: u32 = 0x0001;
  const SWP_NOMOVE: u32 = 0x0002;
  const SWP_NOZORDER: u32 = 0x0004;
  const SWP_FRAMECHANGED: u32 = 0x0020;

  #[link(name = "user32")]
  extern "system" {
    fn GetWindowLongW(hwnd: *mut c_void, index: i32) -> i32;
    fn SetWindowLongW(hwnd: *mut c_void, index: i32, value: i32) -> i32;
    fn SetWindowPos(
      hwnd: *mut c_void,
      insert_after: *mut c_void,
      x: i32,
      y: i32,
      cx: i32,
      cy: i32,
      flags: u32,
    ) -> i32;
  }

  if let Ok(hwnd) = window.hwnd() {
    let raw = hwnd.0 as *mut c_void;
    unsafe {
      let style = GetWindowLongW(raw, GWL_EXSTYLE) as isize;
      let next = (style | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
      SetWindowLongW(raw, GWL_EXSTYLE, next as i32);
      SetWindowPos(
        raw,
        std::ptr::null_mut(),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
      );
    }
  }
}

#[cfg(not(windows))]
fn set_taskbar_hidden(_window: &WebviewWindow) {}

fn db_path(dir: &Path) -> PathBuf {
  dir.join("work-encourager.json")
}

fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = std::env::var_os("WORK_ENC_DATA_DIR") {
    return Ok(PathBuf::from(dir));
  }
  app
    .path()
    .app_data_dir()
    .map_err(|error| format!("无法获取数据目录：{error}"))
}

fn read_db(app: &AppHandle) -> Option<Value> {
  let dir = resolve_data_dir(app).ok()?;
  let text = fs::read_to_string(db_path(&dir)).ok()?;
  serde_json::from_str(&text).ok()
}

fn latest_settings(db: &Value) -> Option<&Value> {
  db.get("settingsTimeline")?.as_array()?.last()?.get("settings")
}

fn setting_str<'a>(settings: &'a Value, key: &str, fallback: &'a str) -> &'a str {
  settings.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

fn setting_bool(settings: &Value, key: &str, fallback: bool) -> bool {
  settings.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn close_action_is_tray(app: &AppHandle) -> bool {
  read_db(app)
    .as_ref()
    .and_then(latest_settings)
    .map(|settings| setting_str(settings, "closeAction", "tray") == "tray")
    .unwrap_or(true)
}

fn minimize_to_tray(app: &AppHandle) -> bool {
  read_db(app)
    .as_ref()
    .and_then(latest_settings)
    .map(|settings| setting_bool(settings, "minimizeToTray", true))
    .unwrap_or(true)
}

fn float_is_visible(app: &AppHandle) -> bool {
  app
    .get_webview_window("float")
    .and_then(|window| window.is_visible().ok())
    .unwrap_or(false)
}

fn pet_is_visible(app: &AppHandle) -> bool {
  app
    .get_webview_window("pet")
    .and_then(|window| window.is_visible().ok())
    .unwrap_or(false)
}

fn pet_today(app: &AppHandle) -> i64 {
  let key = Local::now().format("%Y-%m-%d").to_string();
  read_db(app)
    .and_then(|db| {
      db.get("petDaily")
        .and_then(|daily| daily.get(&key))
        .and_then(Value::as_i64)
    })
    .unwrap_or(0)
}

fn refresh_tray(app: &AppHandle) {
  let Some(tray) = app.tray_by_id("main") else {
    return;
  };
  let timer_on = read_db(app)
    .map(|db| {
      db.get("timer")
        .and_then(|timer| timer.get("on"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
    })
    .unwrap_or(true);
  if let Ok(menu) = build_menu(app, timer_on, float_is_visible(app), pet_is_visible(app), pet_today(app)) {
    let _ = tray.set_menu(Some(menu));
  }
}

fn show_main(app: &AppHandle) {
  if let Some(float) = app.get_webview_window("float") {
    let _ = float.hide();
  }
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_focus();
  }
  refresh_tray(app);
}

fn float_window(app: &AppHandle) -> Result<WebviewWindow, String> {
  app
    .get_webview_window("float")
    .ok_or_else(|| "浮窗尚未创建".to_string())
}

fn show_float(app: &AppHandle) -> Result<(), String> {
  let float = float_window(app)?;
  if let Some(main) = app.get_webview_window("main") {
    let _ = main.hide();
    let _ = main.set_skip_taskbar(true);
  }
  let _ = float.set_skip_taskbar(true);
  let _ = float.show();
  let _ = float.set_skip_taskbar(true);
  set_taskbar_hidden(&float);
  let _ = float.set_focus();
  refresh_tray(app);
  Ok(())
}

fn hide_float(app: &AppHandle) {
  if let Some(float) = app.get_webview_window("float") {
    let _ = float.hide();
  }
  refresh_tray(app);
}

fn toggle_float(app: &AppHandle) {
  if float_is_visible(app) {
    hide_float(app);
  } else if let Err(error) = show_float(app) {
    eprintln!("show float failed: {error}");
  }
}

fn show_pet(app: &AppHandle) -> Result<(), String> {
  let pet = app
    .get_webview_window("pet")
    .ok_or_else(|| "宠物窗口尚未创建".to_string())?;
  let _ = pet.set_skip_taskbar(true);
  pet.show().map_err(|error| format!("显示宠物窗口失败：{error}"))?;
  set_taskbar_hidden(&pet);
  let _ = pet.set_always_on_top(true);
  refresh_tray(app);
  Ok(())
}

fn hide_pet(app: &AppHandle) {
  if let Some(pet) = app.get_webview_window("pet") {
    let _ = pet.hide();
  }
  refresh_tray(app);
}

fn toggle_pet(app: &AppHandle) {
  if pet_is_visible(app) {
    hide_pet(app);
  } else if let Err(error) = show_pet(app) {
    eprintln!("show pet failed: {error}");
  }
}

fn build_menu(
  app: &AppHandle,
  timer_on: bool,
  float_visible: bool,
  pet_visible: bool,
  pet_count: i64,
) -> tauri::Result<Menu<tauri::Wry>> {
  let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
  let float = MenuItem::with_id(
    app,
    "float",
    if float_visible {
      "隐藏桌面浮窗"
    } else {
      "打开桌面浮窗"
    },
    true,
    None::<&str>,
  )?;
  let pet = MenuItem::with_id(
    app,
    "pet",
    if pet_visible {
      "收起摸鱼小宠物".to_string()
    } else if pet_count > 0 {
      format!("摸鱼小宠物（今日 {pet_count} 次）")
    } else {
      "摸鱼小宠物".to_string()
    },
    true,
    None::<&str>,
  )?;
  let toggle = MenuItem::with_id(
    app,
    "toggle",
    if timer_on {
      "关闭计时器"
    } else {
      "开启计时器"
    },
    true,
    None::<&str>,
  )?;
  let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  Menu::with_items(app, &[&show, &float, &pet, &toggle, &settings, &quit])
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
  let menu = build_menu(app, true, false, false, pet_today(app))?;
  let Some(icon) = app.default_window_icon().cloned() else {
    return Ok(());
  };
  TrayIconBuilder::with_id("main")
    .icon(icon)
    .tooltip("上班鼓励器")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show" => show_main(app),
      "float" => toggle_float(app),
      "pet" => toggle_pet(app),
      "toggle" => {
        show_main(app);
        let _ = app.emit("tray-toggle-timer", ());
      }
      "settings" => {
        show_main(app);
        let _ = app.emit("navigate", "settings");
      }
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        ..
      } = event
      {
        show_main(tray.app_handle());
      }
    })
    .build(app)?;
  Ok(())
}

#[tauri::command]
fn load_db(app: AppHandle) -> Result<Option<String>, String> {
  let dir = resolve_data_dir(&app)?;
  match fs::read_to_string(db_path(&dir)) {
    Ok(text) => Ok(Some(text)),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(format!("读取本地数据失败：{error}")),
  }
}

#[tauri::command]
fn save_db(app: AppHandle, json: String) -> Result<(), String> {
  serde_json::from_str::<Value>(&json).map_err(|error| format!("数据不是有效 JSON：{error}"))?;
  write_db_text(&app, &json)
}

fn write_db_text(app: &AppHandle, json: &str) -> Result<(), String> {
  let dir = resolve_data_dir(app)?;
  fs::create_dir_all(&dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
  let path = db_path(&dir);
  let temp = path.with_extension("json.tmp");
  let backup = path.with_extension("json.bak");
  fs::write(&temp, json.as_bytes()).map_err(|error| format!("写入临时数据失败：{error}"))?;
  if path.exists() {
    let _ = fs::remove_file(&backup);
    fs::rename(&path, &backup).map_err(|error| format!("备份旧数据失败：{error}"))?;
  }
  match fs::rename(&temp, &path) {
    Ok(()) => {
      let _ = fs::remove_file(&backup);
      Ok(())
    }
    Err(error) => {
      if backup.exists() {
        let _ = fs::rename(&backup, &path);
      }
      Err(format!("写入本地数据失败：{error}"))
    }
  }
}

#[tauri::command]
fn data_path(app: AppHandle) -> Result<String, String> {
  Ok(db_path(&resolve_data_dir(&app)?).to_string_lossy().to_string())
}

// ---------- Live2D 模型 ----------

fn live2d_root(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(resolve_data_dir(app)?.join("live2d"))
}

fn valid_model_id(id: &str) -> bool {
  id.len() >= 8 && id.len() <= 40 && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// 前端把整理好的文件（贴图已降采样）以 base64 传过来，这里只负责落盘
#[tauri::command]
fn live2d_save(app: AppHandle, id: String, files: Vec<(String, String)>) -> Result<(), String> {
  use base64::Engine;

  if !valid_model_id(&id) {
    return Err("模型 id 不合法".to_string());
  }
  let root = live2d_root(&app)?.join(&id);
  let _ = fs::remove_dir_all(&root);
  fs::create_dir_all(&root).map_err(|error| format!("创建模型目录失败：{error}"))?;
  let engine = base64::engine::general_purpose::STANDARD;
  for (name, data) in files {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
      return Err(format!("文件名不合法：{name}"));
    }
    let target = root.join(&name);
    if let Some(parent) = target.parent() {
      fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let raw = data.split_once("base64,").map(|(_, rest)| rest).unwrap_or(&data);
    let bytes = engine
      .decode(raw.as_bytes())
      .map_err(|error| format!("解码 {name} 失败：{error}"))?;
    fs::write(&target, bytes).map_err(|error| format!("写入 {name} 失败：{error}"))?;
  }
  Ok(())
}

#[tauri::command]
fn live2d_remove(app: AppHandle, id: String) -> Result<(), String> {
  if !valid_model_id(&id) {
    return Ok(());
  }
  let root = live2d_root(&app)?.join(&id);
  if root.exists() {
    fs::remove_dir_all(&root).map_err(|error| format!("删除模型失败：{error}"))?;
  }
  Ok(())
}

#[tauri::command]
fn live2d_open_folder(app: AppHandle) -> Result<(), String> {
  let root = live2d_root(&app)?;
  fs::create_dir_all(&root).map_err(|error| format!("创建模型目录失败：{error}"))?;
  Command::new("explorer")
    .arg(root.as_os_str())
    .spawn()
    .map_err(|error| format!("打开模型目录失败：{error}"))?;
  Ok(())
}

/// Windows 上自定义协议实际走 http://live2d.localhost/<id>/<file>
#[tauri::command]
fn live2d_base_url() -> String {
  "http://live2d.localhost/".to_string()
}

#[tauri::command]
fn pet_apply_style(app: AppHandle, style: String) -> Result<(), String> {
  let Some(pet) = app.get_webview_window("pet") else {
    return Ok(());
  };
  let (width, height) = if style == "live2d" {
    (300.0, 360.0)
  } else {
    (256.0, 280.0)
  };
  pet
    .set_size(tauri::LogicalSize::new(width, height))
    .map_err(|error| format!("调整宠物窗口尺寸失败：{error}"))?;
  Ok(())
}

#[derive(serde::Serialize)]
struct PetEnv {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  work_area: PetArea,
}

#[derive(serde::Serialize)]
struct PetArea {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

#[tauri::command]
fn pet_env(app: AppHandle) -> Result<PetEnv, String> {
  let pet = app
    .get_webview_window("pet")
    .ok_or_else(|| "宠物窗口未创建".to_string())?;
  let scale = pet.scale_factor().unwrap_or(1.0);
  let position = pet
    .outer_position()
    .map_err(|error| format!("读取宠物窗口位置失败：{error}"))?;
  let size = pet
    .outer_size()
    .map_err(|error| format!("读取宠物窗口尺寸失败：{error}"))?;
  let monitor = pet
    .current_monitor()
    .ok()
    .flatten()
    .or_else(|| pet.primary_monitor().ok().flatten());
  let area = monitor
    .map(|monitor| {
      let position = monitor.position();
      let size = monitor.size();
      PetArea {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
      }
    })
    .unwrap_or(PetArea {
      x: 0.0,
      y: 0.0,
      width: 1920.0,
      height: 1080.0,
    });
  Ok(PetEnv {
    x: position.x as f64 / scale,
    y: position.y as f64 / scale,
    width: size.width as f64 / scale,
    height: size.height as f64 / scale,
    work_area: area,
  })
}

#[tauri::command]
fn move_pet_window(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
  let Some(pet) = app.get_webview_window("pet") else {
    return Ok(());
  };
  if !x.is_finite() || !y.is_finite() {
    return Ok(());
  }
  pet
    .set_position(tauri::LogicalPosition::new(x, y))
    .map_err(|error| format!("移动宠物窗口失败：{error}"))
}

fn serve_live2d(app: &AppHandle, path: &str) -> Option<(Vec<u8>, &'static str)> {
  let trimmed = path.trim_start_matches('/');
  let mut parts = trimmed.splitn(2, '/');
  let id = parts.next()?;
  let relative = parts.next()?;
  if !valid_model_id(id) || relative.is_empty() || relative.contains("..") {
    return None;
  }
  let file = live2d_root(app).ok()?.join(id).join(relative);
  let bytes = fs::read(&file).ok()?;
  let mime = if relative.ends_with(".moc3") {
    "application/octet-stream"
  } else if relative.ends_with(".json") {
    "application/json"
  } else if relative.ends_with(".png") {
    "image/png"
  } else {
    "application/octet-stream"
  };
  Some((bytes, mime))
}

#[tauri::command]
fn app_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<String, String> {
  let dir = resolve_data_dir(&app)?;
  let path = db_path(&dir);
  let target = if path.exists() { path.clone() } else { dir };
  Command::new("explorer")
    .arg(format!("/select,{}", target.display()))
    .spawn()
    .map_err(|error| format!("打开数据目录失败：{error}"))?;
  Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
  app.exit(0);
}

#[tauri::command]
fn request_close(app: AppHandle) {
  if close_action_is_tray(&app) {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.hide();
      let _ = window.set_skip_taskbar(true);
    }
  } else {
    app.exit(0);
  }
  refresh_tray(&app);
}

#[tauri::command]
fn minimize_or_hide(app: AppHandle) {
  if minimize_to_tray(&app) {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.hide();
    }
  } else if let Some(window) = app.get_webview_window("main") {
    let _ = window.minimize();
  }
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, value: bool) -> Result<(), String> {
  window
    .set_always_on_top(value)
    .map_err(|error| format!("设置窗口置顶失败：{error}"))
}

#[tauri::command]
fn update_tray(app: AppHandle, timer_on: bool, tooltip: String) -> Result<(), String> {
  let Some(tray) = app.tray_by_id("main") else {
    return Ok(());
  };
  let _ = tray.set_tooltip(Some(tooltip));
  let menu = build_menu(
    &app,
    timer_on,
    float_is_visible(&app),
    pet_is_visible(&app),
    pet_today(&app),
  )
  .map_err(|error| error.to_string())?;
  tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn show_pet_window(app: AppHandle) -> Result<(), String> {
  show_pet(&app)
}

#[tauri::command]
fn hide_pet_window(app: AppHandle) {
  hide_pet(&app);
}

#[tauri::command]
fn toggle_pet_window(app: AppHandle) -> Result<bool, String> {
  if pet_is_visible(&app) {
    hide_pet(&app);
    Ok(false)
  } else {
    show_pet(&app)?;
    Ok(true)
  }
}

#[tauri::command]
fn save_pet_bounds(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
  let mut db = read_db(&app).unwrap_or_else(|| Value::Object(Default::default()));
  if !db.is_object() {
    db = Value::Object(Default::default());
  }
  if let Some(object) = db.as_object_mut() {
    object.insert(
      "petBounds".to_string(),
      serde_json::json!({ "x": x.round() as i64, "y": y.round() as i64 }),
    );
  }
  write_db_text(&app, &db.to_string())
}

#[tauri::command]
fn show_float_window(app: AppHandle) -> Result<(), String> {
  show_float(&app)
}

#[tauri::command]
fn hide_float_window(app: AppHandle) {
  hide_float(&app);
}

#[tauri::command]
fn expand_float_window(app: AppHandle) {
  show_main(&app);
}

fn parse_time(value: &str) -> Option<NaiveTime> {
  NaiveTime::parse_from_str(value, "%H:%M").ok()
}

fn is_workday(settings: &Value, date: NaiveDate) -> bool {
  let date_key = date.format("%Y-%m-%d").to_string();
  if let Some(special) = settings
    .get("specialDays")
    .and_then(Value::as_array)
    .and_then(|items| {
      items.iter().find(|item| {
        item.get("date").and_then(Value::as_str) == Some(date_key.as_str())
      })
    })
  {
    return special.get("type").and_then(Value::as_str) == Some("work");
  }
  let weekday = date.weekday().number_from_monday() as i64;
  settings
    .get("weekdays")
    .and_then(Value::as_array)
    .map(|days| days.iter().any(|day| day.as_i64() == Some(weekday)))
    .unwrap_or(false)
}

struct ShiftEnd {
  work_date: String,
  end: DateTime<Local>,
}

fn shift_for(settings: &Value, date: NaiveDate) -> Option<ShiftEnd> {
  if !is_workday(settings, date) {
    return None;
  }
  let start = parse_time(setting_str(settings, "workStart", "09:00"))?;
  let end = parse_time(setting_str(settings, "workEnd", "17:00"))?;
  let start_dt = Local.from_local_datetime(&date.and_time(start)).single()?;
  let mut end_date = date;
  if end <= start {
    end_date = date.succ_opt()?;
  }
  let end_dt = Local.from_local_datetime(&end_date.and_time(end)).single()?;
  if end_dt <= start_dt {
    return None;
  }
  Some(ShiftEnd {
    work_date: date.format("%Y-%m-%d").to_string(),
    end: end_dt,
  })
}

fn due_reminder(app: &AppHandle, fired: &HashSet<String>) -> Option<(String, String)> {
  let db = read_db(app)?;
  let settings = latest_settings(&db)?;
  if !setting_bool(settings, "reminderEnabled", true) {
    return None;
  }
  let minutes = settings
    .get("reminderMinutes")
    .and_then(Value::as_i64)
    .unwrap_or(10)
    .clamp(0, 720);
  let now = Local::now();
  let today = now.date_naive();
  let yesterday = today.pred_opt()?;
  let candidates = [shift_for(settings, today), shift_for(settings, yesterday)];

  for candidate in candidates.into_iter().flatten() {
    if fired.contains(&candidate.work_date) {
      continue;
    }
    let due = candidate.end - chrono::Duration::minutes(minutes);
    if now < due || now > candidate.end + chrono::Duration::minutes(5) {
      continue;
    }
    let remaining = (candidate.end - now).num_minutes().max(0);
    let body = if remaining > 0 {
      format!("距离下班还有 {remaining} 分钟，准备收工啦。")
    } else {
      "下班时间到，今天辛苦了。".to_string()
    };
    return Some((candidate.work_date, body));
  }
  None
}

fn load_fired(dir: &Path) -> HashSet<String> {
  let path = dir.join("reminders-fired.json");
  let Ok(text) = fs::read_to_string(path) else {
    return HashSet::new();
  };
  serde_json::from_str::<Vec<String>>(&text)
    .map(|items| items.into_iter().collect())
    .unwrap_or_default()
}

fn persist_fired(dir: &Path, fired: &HashSet<String>) {
  let mut items: Vec<&String> = fired.iter().collect();
  items.sort();
  if let Ok(text) = serde_json::to_string(&items) {
    let _ = fs::write(dir.join("reminders-fired.json"), text);
  }
}

fn spawn_reminders(app: AppHandle) {
  std::thread::spawn(move || loop {
    std::thread::sleep(Duration::from_secs(20));
    let state = app.state::<AppState>();
    let fired = state.fired.lock().map(|guard| guard.clone()).unwrap_or_default();
    if let Some((work_date, body)) = due_reminder(&app, &fired) {
      if let Ok(mut guard) = state.fired.lock() {
        guard.insert(work_date);
        persist_fired(&state.data_dir, &guard);
      }
      let _ = app
        .notification()
        .builder()
        .title("上班鼓励器")
        .body(body)
        .show();
    }
  });
}

fn persist_pet_position(window: &tauri::Window) {
  use std::sync::atomic::{AtomicU64, Ordering};
  static LAST_SAVE_MS: AtomicU64 = AtomicU64::new(0);

  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as u64)
    .unwrap_or(0);
  if now.saturating_sub(LAST_SAVE_MS.load(Ordering::Relaxed)) < 400 {
    return;
  }
  LAST_SAVE_MS.store(now, Ordering::Relaxed);

  let Ok(position) = window.outer_position() else {
    return;
  };
  let scale = window.scale_factor().unwrap_or(1.0);
  let _ = save_pet_bounds(
    window.app_handle().clone(),
    position.x as f64 / scale,
    position.y as f64 / scale,
  );
}

pub fn run() {
  let mut context = tauri::generate_context!();
  if let Ok(dir) = std::env::var("WORK_ENC_DATA_DIR") {
    context.config_mut().app.app_directories_override =
      Some(AppDirectoriesOverride::Root(dir.into()));
  }
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      show_main(app);
    }))
    .plugin(tauri_plugin_notification::init())
    .register_uri_scheme_protocol("live2d", |ctx, request| {
      let app = ctx.app_handle();
      let path = request.uri().path().to_string();
      match serve_live2d(app, &path) {
        Some((bytes, mime)) => {
          let body: std::borrow::Cow<'static, [u8]> = bytes.into();
          tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-cache")
            .body(body)
            .unwrap_or_else(|_| tauri::http::Response::new(std::borrow::Cow::Borrowed(&[])))
        }
        None => {
          let body: std::borrow::Cow<'static, [u8]> = Vec::new().into();
          tauri::http::Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(body)
            .unwrap_or_else(|_| tauri::http::Response::new(std::borrow::Cow::Borrowed(&[])))
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      load_db,
      save_db,
      data_path,
      app_version,
      open_data_folder,
      quit_app,
      request_close,
      minimize_or_hide,
      set_always_on_top,
      update_tray,
      show_float_window,
      hide_float_window,
      expand_float_window,
      show_pet_window,
      hide_pet_window,
      toggle_pet_window,
      save_pet_bounds,
      live2d_save,
      live2d_remove,
      live2d_open_folder,
      live2d_base_url,
      pet_apply_style,
      pet_env,
      move_pet_window
    ])
    .setup(|app| {
      let data_dir = if let Some(dir) = std::env::var_os("WORK_ENC_DATA_DIR") {
        PathBuf::from(dir)
      } else {
        app.path().app_data_dir().map_err(|error| {
          std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("无法获取数据目录：{error}"),
          )
        })?
      };
      fs::create_dir_all(&data_dir).map_err(|error| {
        std::io::Error::new(
          std::io::ErrorKind::Other,
          format!("创建数据目录失败 {}：{error}", data_dir.display()),
        )
      })?;
      let fired = load_fired(&data_dir);
      app.manage(AppState {
        data_dir,
        fired: Mutex::new(fired),
      });
      create_tray(app.handle())?;
      if let Some(float) = app.get_webview_window("float") {
        if let Ok(Some(monitor)) = float.primary_monitor() {
          let scale = monitor.scale_factor();
          let size = monitor.size();
          let position = monitor.position();
          let x = position.x as f64 / scale + size.width as f64 / scale - 288.0;
          let y = position.y as f64 / scale + size.height as f64 / scale - 180.0;
          let _ = float.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = float.set_skip_taskbar(true);
        set_taskbar_hidden(&float);
      }
      if let Some(pet) = app.get_webview_window("pet") {
        let saved = read_db(app.handle())
          .and_then(|db| db.get("petBounds").cloned())
          .and_then(|bounds| {
            let x = bounds.get("x")?.as_f64()?;
            let y = bounds.get("y")?.as_f64()?;
            Some((x, y))
          });
        if let Some((x, y)) = saved {
          let _ = pet.set_position(tauri::LogicalPosition::new(x, y));
        } else if let Ok(Some(monitor)) = pet.primary_monitor() {
          let scale = monitor.scale_factor();
          let size = monitor.size();
          let position = monitor.position();
          let width = size.width as f64 / scale;
          let height = size.height as f64 / scale;
          let x = position.x as f64 / scale + width - 268.0;
          let y = position.y as f64 / scale + height - 460.0;
          let _ = pet.set_position(tauri::LogicalPosition::new(x, y));
        }
        let _ = pet.set_skip_taskbar(true);
        set_taskbar_hidden(&pet);
        // 用 Live2D 形象时窗口要比团子猫大一圈，否则角色会被裁掉
        let style = read_db(app.handle())
          .and_then(|db| db.get("petStyle").and_then(|value| value.as_str().map(str::to_string)))
          .unwrap_or_else(|| "mochi".to_string());
        if style == "live2d" {
          let _ = pet.set_size(tauri::LogicalSize::new(300.0, 360.0));
        }
      }
      spawn_reminders(app.handle().clone());
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() == "float" {
        if let WindowEvent::CloseRequested { api, .. } = event {
          api.prevent_close();
          let _ = window.hide();
          refresh_tray(window.app_handle());
        }
        return;
      }
      if window.label() == "pet" {
        match event {
          WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            refresh_tray(window.app_handle());
          }
          WindowEvent::Moved(_) => persist_pet_position(window),
          _ => {}
        }
        return;
      }
      if window.label() != "main" {
        return;
      }
      match event {
        WindowEvent::CloseRequested { api, .. } => {
          if close_action_is_tray(window.app_handle()) {
            api.prevent_close();
            let _ = window.hide();
            let _ = window.set_skip_taskbar(true);
            refresh_tray(window.app_handle());
          }
        }
        WindowEvent::Resized(_) => {
          if window.is_minimized().unwrap_or(false) && minimize_to_tray(window.app_handle()) {
            let _ = window.hide();
          }
        }
        _ => {}
      }
    })
    .run(context)
    .expect("error while running tauri application");
}
