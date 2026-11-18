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

/// 宠物窗是 WebView2 在启动后异步建好的，头一两秒里 get_webview_window 可能还查不到，
/// 这里等一会儿再报错，免得开机就点「摸鱼」却什么都不发生。
fn wait_pet_window(app: &AppHandle) -> Option<WebviewWindow> {
  let start = std::time::Instant::now();
  loop {
    if let Some(window) = app.get_webview_window("pet") {
      return Some(window);
    }
    if start.elapsed().as_millis() > 3000 {
      return None;
    }
    std::thread::sleep(std::time::Duration::from_millis(40));
  }
}

fn show_pet(app: &AppHandle) -> Result<(), String> {
  let pet = wait_pet_window(app).ok_or_else(|| "宠物窗口尚未创建".to_string())?;
  let _ = pet.set_skip_taskbar(true);
  // 上次拖到已经拔掉的显示器、或者分辨率换过之后，先摆回可见区域再显示
  clamp_pet_position(&pet);
  log_pet(app, "show: 开始显示宠物窗口");
  pet.show().map_err(|error| format!("显示宠物窗口失败：{error}"))?;
  // 透明窗在部分显卡驱动上第一次 show 不触发重绘，给一次同尺寸 set_size 逼它画一帧
  let (pet_width, pet_height) = pet_size_of(pet_scale_of(app));
  let _ = pet.set_size(tauri::LogicalSize::new(pet_width, pet_height));
  set_taskbar_hidden(&pet);
  let _ = pet.set_always_on_top(true);
  if !pet.is_visible().unwrap_or(true) {
    // 个别机器上透明窗第一次 show 会停在不可见状态：挪到主屏右下角、抢一次焦点再显示
    if let Some((x, y)) = default_pet_position(&pet) {
      let _ = pet.set_position(tauri::LogicalPosition::new(x, y));
    }
    let _ = pet.show();
    let _ = pet.set_always_on_top(true);
    let _ = pet.set_focus();
    log_pet(app, "show: 第一次没显示出来，已重新定位并再次显示");
  }
  if !pet.is_visible().unwrap_or(true) {
    let detail = pet
      .outer_position()
      .map(|p| format!("{},{}", p.x, p.y))
      .unwrap_or_else(|_| "未知".to_string());
    log_pet(app, &format!("show: 仍然不可见，位置 {detail}"));
    return Err(format!("宠物窗口没能显示出来（位置 {detail}）"));
  }
  log_pet(app, "show: 已显示");
  refresh_tray(app);
  Ok(())
}

/// 默认落点（逻辑像素）：贴着任务栏上沿，距右边缘 5% 屏宽
fn default_pet_position(pet: &WebviewWindow) -> Option<(f64, f64)> {
  let monitor = pet.primary_monitor().ok().flatten()?;
  let scale = monitor.scale_factor();
  let (pet_width, pet_height) = pet_size_of(pet_scale_of(pet.app_handle()));
  let work = monitor.work_area();
  let x = work.position.x as f64 / scale;
  let y = work.position.y as f64 / scale;
  let width = work.size.width as f64 / scale;
  let height = work.size.height as f64 / scale;
  Some((x + width - pet_width - width * 0.05, y + height - pet_height - 8.0))
}

/// 把宠物窗夹回它所在显示器的可见工作区
fn clamp_pet_position(pet: &WebviewWindow) {
  let Some((ax, ay, aw, ah)) = pet_work_area(pet) else {
    return;
  };
  let Ok(position) = pet.outer_position() else {
    return;
  };
  let scale = pet.scale_factor().unwrap_or(1.0);
  let (pet_width, pet_height) = pet_size_of(pet_scale_of(pet.app_handle()));
  let x = position.x as f64 / scale;
  let y = position.y as f64 / scale;
  let next_x = x.min(ax + aw - pet_width).max(ax);
  let next_y = y.min(ay + ah - pet_height).max(ay);
  if (next_x - x).abs() > 1.0 || (next_y - y).abs() > 1.0 {
    let _ = pet.set_position(tauri::LogicalPosition::new(next_x, next_y));
  }
}

/// 宠物窗所在显示器的可见工作区（逻辑像素）
fn pet_work_area(pet: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
  let monitor = pet
    .current_monitor()
    .ok()
    .flatten()
    .or_else(|| pet.primary_monitor().ok().flatten())?;
  let scale = pet.scale_factor().unwrap_or(1.0);
  let work = monitor.work_area();
  Some((
    work.position.x as f64 / scale,
    work.position.y as f64 / scale,
    work.size.width as f64 / scale,
    work.size.height as f64 / scale,
  ))
}

/// 宠物窗的显示问题只在这台机器上复现过，留一份很小的日志方便现场排查
fn log_pet(app: &AppHandle, message: &str) {
  let Some(state) = app.try_state::<AppState>() else {
    return;
  };
  let path = state.data_dir.join("pet.log");
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  let _ = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .and_then(|mut file| {
      use std::io::Write;
      writeln!(file, "[{stamp}] {message}")
    });
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

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
  fs::create_dir_all(to)?;
  for entry in fs::read_dir(from)? {
    let entry = entry?;
    let target = to.join(entry.file_name());
    if entry.path().is_dir() {
      copy_dir(&entry.path(), &target)?;
    } else {
      fs::copy(entry.path(), target)?;
    }
  }
  Ok(())
}

/// 安装包里随附了一份整理好的 Live2D 模型，首次启动时放进数据目录并直接启用。
/// 已经有模型（用户自己导入过）时什么都不做。
#[allow(dead_code)]
fn install_bundled_model(app: &AppHandle) -> Result<(), String> {
  let already = read_db(app)
    .and_then(|db| db.get("live2d").cloned())
    .map(|value| !value.is_null())
    .unwrap_or(false);
  if already {
    return Ok(());
  }
  let resource = match app.path().resource_dir() {
    Ok(dir) => dir,
    Err(_) => return Ok(()),
  };
  let source = resource.join("resources").join("live2d");
  let manifest_path = source.join("manifest.json");
  if !manifest_path.exists() {
    return Ok(());
  }
  let manifest: Value = serde_json::from_str(
    &fs::read_to_string(&manifest_path).map_err(|error| format!("读取内置模型清单失败：{error}"))?,
  )
  .map_err(|error| format!("内置模型清单不是有效 JSON：{error}"))?;
  let id = manifest
    .get("id")
    .and_then(|value| value.as_str())
    .unwrap_or("")
    .to_string();
  if !valid_model_id(&id) {
    return Ok(());
  }
  let from = source.join(&id);
  if !from.join("model3.json").exists() {
    return Ok(());
  }
  let to = live2d_root(app)?.join(&id);
  let _ = fs::remove_dir_all(&to);
  copy_dir(&from, &to).map_err(|error| format!("安装内置模型失败：{error}"))?;

  let name = manifest
    .get("name")
    .and_then(|value| value.as_str())
    .unwrap_or("内置模型")
    .to_string();
  let textures = manifest.get("textures").and_then(|value| value.as_u64()).unwrap_or(0);
  let imported_at = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as u64)
    .unwrap_or(0);
  let mut db = read_db(app).unwrap_or_else(|| serde_json::json!({}));
  if let Some(object) = db.as_object_mut() {
    object.insert(
      "live2d".to_string(),
      serde_json::json!({
        "id": id,
        "name": name,
        "importedAt": imported_at,
        "textures": textures,
        "source": "bundled"
      }),
    );
    object.insert("petStyle".to_string(), serde_json::json!("live2d"));
  }
  write_db_text(app, &serde_json::to_string(&db).map_err(|error| error.to_string())?)
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

/// 100% 比例下的宠物窗尺寸（逻辑像素），实际尺寸 = 基准 × petScale
const PET_BASE_WIDTH: f64 = 210.0;
const PET_BASE_HEIGHT: f64 = 266.0;
const PET_SCALE_DEFAULT: f64 = 0.8;

fn normalize_pet_scale(raw: Option<f64>) -> f64 {
  match raw {
    Some(value) if value.is_finite() => value.clamp(0.6, 1.4),
    _ => PET_SCALE_DEFAULT,
  }
}

/// 从 db 里读宠物比例；没写过就按默认 80%
fn pet_scale_of(app: &AppHandle) -> f64 {
  normalize_pet_scale(read_db(app).and_then(|db| db.get("petScale").and_then(|value| value.as_f64())))
}

fn pet_size_of(scale: f64) -> (f64, f64) {
  (
    (PET_BASE_WIDTH * scale).round(),
    (PET_BASE_HEIGHT * scale).round(),
  )
}

#[tauri::command]
fn pet_apply_style(app: AppHandle, style: String) -> Result<(), String> {
  let Some(pet) = app.get_webview_window("pet") else {
    return Ok(());
  };
  let _ = style;
  let (width, height) = pet_size_of(pet_scale_of(&app));
  pet
    .set_size(tauri::LogicalSize::new(width, height))
    .map_err(|error| format!("调整宠物窗口尺寸失败：{error}"))?;
  Ok(())
}

/// 设置页拖动比例滑杆时调用：按中心等比缩放，并把新比例广播给宠物页重新排版角色
#[tauri::command]
fn pet_apply_scale(app: AppHandle, scale: f64) -> Result<f64, String> {
  let next = normalize_pet_scale(Some(scale));
  if let Some(pet) = app.get_webview_window("pet") {
    let (width, height) = pet_size_of(next);
    let factor = pet.scale_factor().unwrap_or(1.0);
    let center = pet.outer_position().ok().map(|position| {
      let size = pet.outer_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
      (
        position.x as f64 + size.width as f64 / 2.0,
        position.y as f64 + size.height as f64 / 2.0,
      )
    });
    pet
      .set_size(tauri::LogicalSize::new(width, height))
      .map_err(|error| format!("调整宠物窗口尺寸失败：{error}"))?;
    if let Some((cx, cy)) = center {
      // 以中心为锚点：不然一放大就往下掉出屏幕
      let x = cx - width * factor / 2.0;
      let y = cy - height * factor / 2.0;
      let _ = pet.set_position(tauri::LogicalPosition::new(x / factor, y / factor));
      clamp_pet_position(&pet);
    }
    let _ = pet.emit("pet-scale", next);
  }
  Ok(next)
}

#[derive(serde::Serialize)]
struct PetEnv {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  /// 宠物显示比例，渲染层据此缩放角色
  scale: f64,
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
      let work = monitor.work_area();
      PetArea {
        x: work.position.x as f64 / scale,
        y: work.position.y as f64 / scale,
        width: work.size.width as f64 / scale,
        height: work.size.height as f64 / scale,
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
    scale: pet_scale_of(&app),
    work_area: area,
  })
}

#[derive(serde::Serialize)]
struct PetPos {
  x: f64,
  y: f64,
}

#[tauri::command]
fn move_pet_window(app: AppHandle, x: f64, y: f64) -> Result<PetPos, String> {
  let Some(pet) = app.get_webview_window("pet") else {
    return Err("宠物窗口未创建".to_string());
  };
  if !x.is_finite() || !y.is_finite() {
    return Err("窗口位置无效".to_string());
  }
  let scale = pet.scale_factor().unwrap_or(1.0);
  let size = pet
    .outer_size()
    .map_err(|error| format!("读取宠物窗口尺寸失败：{error}"))?;
  let area = pet
    .current_monitor()
    .ok()
    .flatten()
    .or_else(|| pet.primary_monitor().ok().flatten())
    .map(|monitor| {
      let work = monitor.work_area();
      (
        work.position.x as f64,
        work.position.y as f64,
        work.size.width as f64,
        work.size.height as f64,
      )
    });
  let (mut px, mut py) = (x * scale, y * scale);
  if let Some((ax, ay, aw, ah)) = area {
    px = px.min(ax + aw - size.width as f64).max(ax);
    py = py.min(ay + ah - size.height as f64).max(ay);
  }
  pet
    .set_position(tauri::PhysicalPosition::new(px.round() as i32, py.round() as i32))
    .map_err(|error| format!("移动宠物窗口失败：{error}"))?;
  // 回传真正生效的位置：被屏幕边缘夹住时前端据此重新锚定，手指和窗口不会越拖越错位
  Ok(PetPos {
    x: px.round() / scale,
    y: py.round() / scale,
  })
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
      pet_apply_scale,
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
          let y = position.y as f64 / scale + size.height as f64 / scale - 131.0;
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
        } else if let Some((x, y)) = default_pet_position(&pet) {
          let _ = pet.set_position(tauri::LogicalPosition::new(x, y));
        }
        let _ = pet.set_skip_taskbar(true);
        set_taskbar_hidden(&pet);
        let (pet_width, pet_height) = pet_size_of(pet_scale_of(pet.app_handle()));
  let _ = pet.set_size(tauri::LogicalSize::new(pet_width, pet_height));
        // 上次的位置可能是已经拔掉的显示器，先夹回可见区域
        clamp_pet_position(&pet);
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
