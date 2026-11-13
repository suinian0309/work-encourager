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
  if let Ok(menu) = build_menu(app, timer_on, float_is_visible(app)) {
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

fn build_menu(
  app: &AppHandle,
  timer_on: bool,
  float_visible: bool,
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
  Menu::with_items(app, &[&show, &float, &toggle, &settings, &quit])
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
  let menu = build_menu(app, true, false)?;
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
  let dir = resolve_data_dir(&app)?;
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
  let menu =
    build_menu(&app, timer_on, float_is_visible(&app)).map_err(|error| error.to_string())?;
  tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
  Ok(())
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
      expand_float_window
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
          let x = position.x as f64 / scale + size.width as f64 / scale - 280.0;
          let y = position.y as f64 / scale + size.height as f64 / scale - 172.0;
          let _ = float.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = float.set_skip_taskbar(true);
        set_taskbar_hidden(&float);
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
