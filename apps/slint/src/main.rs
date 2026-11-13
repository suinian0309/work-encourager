#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod model;

slint::include_modules!();

use model::*;
use slint::{ComponentHandle, ModelRc, SharedString, Timer, TimerMode, VecModel};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

fn money(v: f64, d: usize) -> String {
  format!("{:.*}", d, v)
}

fn settings_lines(db: &Db) -> Vec<SharedString> {
  let mut rows: Vec<&DayRecord> = db.records.iter().collect();
  rows.sort_by(|a, b| b.work_date.cmp(&a.work_date));
  rows
    .into_iter()
    .map(|r| {
      SharedString::from(format!(
        "{}  正常 ¥{:.2} + 加班 ¥{:.2} = ¥{:.2}",
        r.work_date, r.base_income, r.overtime_income, r.income
      ))
    })
    .collect()
}

fn refresh(ui: &MainWindow, float: &FloatWindow, db: &Db) {
  let s = engine::compute(db, chrono::Local::now().timestamp_millis());
  let cfg = db.latest_settings();
  ui.set_date_text(s.date_text.into());
  ui.set_time_text(s.time_text.clone().into());
  ui.set_status_text(s.status_label.clone().into());
  ui.set_countdown_title(s.countdown_title.clone().into());
  ui.set_countdown_text(s.countdown_text.clone().into());
  ui.set_hint_text(s.hint.clone().into());
  ui.set_earn_text(money(s.earn_today, cfg.decimals.clamp(2, 6) as usize).into());
  ui.set_rate_text(if s.status == "overtime" {
    format!("加班速度 {:.4} 元/秒", s.rate).into()
  } else {
    format!("当前赚钱速度 {:.4} 元/秒", s.rate).into()
  });
  ui.set_normal_text(format!("正常 ¥{:.2}", s.base_income).into());
  ui.set_overtime_text(format!("加班 ¥{:.2}", s.overtime_income).into());
  ui.set_progress(s.progress as f32);
  ui.set_progress_text(format!("{:.1}%", s.progress * 100.0).into());
  ui.set_worked_text(format!("{:.2}", s.base_seconds / 3600.0).into());
  ui.set_planned_text(format!("{:.1}", s.planned_seconds / 3600.0).into());
  ui.set_month_text(format!("¥{:.2}", s.month_total).into());
  ui.set_notice_text(format!("{} 个工作日 · 含加班", s.month_days).into());
  ui.set_is_overtime(s.status == "overtime");
  ui.set_has_overtime(s.overtime_income > 0.0);
  ui.set_overtime_label(if cfg.overtime_enabled {
    format!("加班计薪 · {:.1}×", cfg.overtime_multiplier).into()
  } else {
    "正常计薪".into()
  });
  ui.set_timer_on(db.timer_on);
  ui.set_primary_label(if s.status == "overtime" {
    "结束加班".into()
  } else if db.timer_on {
    "关闭计时器".into()
  } else {
    "开启计时器".into()
  });
  ui.set_history_lines(ModelRc::from(Rc::new(VecModel::from(settings_lines(db)))));

  float.set_status_text(s.status_label.into());
  float.set_time_text(s.time_text.clone().into());
  float.set_countdown_text(if s.status == "overtime" {
    format!("已加班 {}", s.countdown_text).into()
  } else {
    format!("{} {}", s.countdown_title, s.countdown_text).into()
  });
  float.set_earn_text(money(s.earn_today, 2).into());
  float.set_overtime_text(if s.overtime_income > 0.0 {
    format!("加班 ¥{:.2} · {}", s.overtime_income, s.countdown_text).into()
  } else {
    format!("正常 ¥{:.2}", s.base_income).into()
  });
  float.set_progress(s.progress as f32);
  float.set_level(cfg.float_opacity.clamp(0.3, 1.0));
}

#[cfg(windows)]
fn window_style(title: &str, tool: bool, alpha: Option<u8>) {
  use windows_sys::Win32::UI::WindowsAndMessaging::*;
  let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
  let hwnd = unsafe { FindWindowW(std::ptr::null(), wide.as_ptr()) };
  if hwnd.is_null() {
    return;
  }
  unsafe {
    let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if tool {
      style |= WS_EX_TOOLWINDOW as isize;
      style &= !(WS_EX_APPWINDOW as isize);
      style |= WS_EX_LAYERED as isize;
    } else {
      style &= !(WS_EX_TOOLWINDOW as isize);
      style |= WS_EX_APPWINDOW as isize;
      style &= !(WS_EX_LAYERED as isize);
    }
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    if let Some(a) = alpha {
      SetLayeredWindowAttributes(hwnd, 0, a, LWA_ALPHA);
    }
    SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    if tool {
      // 圆角裁切：避免分层窗口在四角留下方形黑边
      use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
      let mut rect = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
      GetWindowRect(hwnd, &mut rect);
      let w = rect.right - rect.left;
      let h = rect.bottom - rect.top;
      if w > 0 && h > 0 {
        let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, 40, 40);
        if !rgn.is_null() {
          SetWindowRgn(hwnd, rgn, 1);
        }
      }
    }
  }
}

#[cfg(not(windows))]
fn window_style(_title: &str, _tool: bool, _alpha: Option<u8>) {}

#[cfg(windows)]
fn position_float() {
  use windows_sys::Win32::UI::WindowsAndMessaging::*;
  let wide: Vec<u16> = "上班鼓励器 · 浮窗".encode_utf16().chain(std::iter::once(0)).collect();
  let hwnd = unsafe { FindWindowW(std::ptr::null(), wide.as_ptr()) };
  if hwnd.is_null() {
    return;
  }
  let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
  let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
  unsafe {
    SetWindowPos(
      hwnd,
      HWND_TOPMOST,
      screen_w - 280,
      screen_h - 240,
      260,
      152,
      SWP_SHOWWINDOW,
    );
  }
}

#[cfg(not(windows))]
fn position_float() {}

/// 无边框浮窗拖动：把鼠标按下转交给系统 caption 拖动循环
#[cfg(windows)]
fn drag_float() {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
  use windows_sys::Win32::UI::WindowsAndMessaging::*;
  let wide: Vec<u16> = "上班鼓励器 · 浮窗".encode_utf16().chain(std::iter::once(0)).collect();
  let hwnd = unsafe { FindWindowW(std::ptr::null(), wide.as_ptr()) };
  if hwnd.is_null() {
    return;
  }
  unsafe {
    ReleaseCapture();
    SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as usize, 0);
  }
}

#[cfg(not(windows))]
fn drag_float() {}

#[cfg(windows)]
fn topmost(title: &str, on: bool) {
  use windows_sys::Win32::UI::WindowsAndMessaging::*;
  let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
  let hwnd = unsafe { FindWindowW(std::ptr::null(), wide.as_ptr()) };
  if hwnd.is_null() {
    return;
  }
  let after = if on { -1isize } else { -2isize } as *mut core::ffi::c_void;
  unsafe {
    SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
}

#[cfg(not(windows))]
fn topmost(_title: &str, _on: bool) {}

#[cfg(windows)]
fn drag_window_title(title: &str) {
  use windows_sys::Win32::UI::WindowsAndMessaging::*;
  let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
  let hwnd = unsafe { FindWindowW(std::ptr::null(), wide.as_ptr()) };
  if !hwnd.is_null() {
    unsafe {
      SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as usize, 0);
    }
  }
}

#[cfg(not(windows))]
fn drag_window_title(_title: &str) {}

fn create_tray() -> Option<TrayIcon> {
  let menu = Menu::new();
  let show = MenuItem::with_id("show", "显示主窗口", true, None);
  let float = MenuItem::with_id("float", "显示/关闭浮窗", true, None);
  let toggle = MenuItem::with_id("toggle", "开启/关闭计时器", true, None);
  let settings = MenuItem::with_id("settings", "设置", true, None);
  let quit = MenuItem::with_id("quit", "退出", true, None);
  menu
    .append_items(&[&show, &float, &PredefinedMenuItem::separator(), &toggle, &settings, &PredefinedMenuItem::separator(), &quit])
    .ok()?;
  let mut rgba = vec![0u8; 32 * 32 * 4];
  for y in 0..32 {
    for x in 0..32 {
      let i = (y * 32 + x) * 4;
      rgba[i] = 52;
      rgba[i + 1] = 179;
      rgba[i + 2] = 136;
      rgba[i + 3] = 255;
    }
  }
  let icon = Icon::from_rgba(rgba, 32, 32).ok()?;
  TrayIconBuilder::new()
    .with_menu(Box::new(menu))
    .with_tooltip("上班鼓励器")
    .with_icon(icon)
    .build()
    .ok()
}

fn main() {
  let now = chrono::Local::now().timestamp_millis();
  let db = Rc::new(RefCell::new(load_db().unwrap_or_else(|_| Db::new(now))));
  let _ = save_db(&db.borrow());
  let _tray = create_tray();

  let ui = MainWindow::new().unwrap();
  let float = FloatWindow::new().unwrap();
  float.hide().unwrap();
  refresh(&ui, &float, &db.borrow());
  ui.show().unwrap();
  window_style("上班鼓励器", false, None);
  topmost("上班鼓励器", db.borrow().latest_settings().always_on_top);
  if let Ok(view) = std::env::var("WORK_ENC_VIEW") {
    if view == "settings" {
      ui.set_show_settings(true);
    } else if view == "history" {
      ui.set_show_history(true);
    }
  }
  if std::env::args().any(|a| a == "--float") {
    ui.hide().unwrap();
    float.show().unwrap();
    position_float();
    let alpha = (float.get_level().clamp(0.3, 1.0) * 255.0) as u8;
    window_style("上班鼓励器 · 浮窗", true, Some(alpha));
  }

  let open_settings = {
    let db = db.clone();
    move |ui: &MainWindow| {
      let s = db.borrow().latest_settings();
      ui.set_edit_start(s.work_start.clone().into());
      ui.set_edit_end(s.work_end.clone().into());
      ui.set_edit_lunch_start(s.breaks.first().map(|b| b.start.clone()).unwrap_or_else(|| "12:00".into()).into());
      ui.set_edit_lunch_end(s.breaks.first().map(|b| b.end.clone()).unwrap_or_else(|| "13:00".into()).into());
      ui.set_edit_daily(format!("{:.2}", s.daily_wage).into());
      ui.set_edit_overtime(s.overtime_enabled);
      ui.set_edit_fixed(s.overtime_hourly > 0.0);
      ui.set_edit_overtime_rate(format!("{:.2}", s.overtime_hourly).into());
      ui.set_edit_multiplier(format!("{:.2}", s.overtime_multiplier).into());
      ui.set_edit_opacity(s.float_opacity.clamp(0.3, 1.0) as f32);
      ui.set_edit_always_on_top(s.always_on_top);
      ui.set_edit_decimals(format!("{}", s.decimals).into());
      ui.set_edit_mode(s.wage_mode.clone().into());
      ui.set_edit_monthly(format!("{:.2}", s.monthly_wage).into());
      ui.set_edit_hourly(format!("{:.2}", s.hourly_wage).into());
      ui.set_edit_basis(s.monthly_basis.clone().into());
      ui.set_edit_fixed_days(format!("{:.2}", s.fixed_days).into());
      ui.set_edit_mon(s.weekdays.contains(&1));
      ui.set_edit_tue(s.weekdays.contains(&2));
      ui.set_edit_wed(s.weekdays.contains(&3));
      ui.set_edit_thu(s.weekdays.contains(&4));
      ui.set_edit_fri(s.weekdays.contains(&5));
      ui.set_edit_sat(s.weekdays.contains(&6));
      ui.set_edit_sun(s.weekdays.contains(&7));
      if let Some(b) = s.breaks.get(1) {
        ui.set_edit_break2(true);
        ui.set_edit_break2_start(b.start.clone().into());
        ui.set_edit_break2_end(b.end.clone().into());
      } else {
        ui.set_edit_break2(false);
      }
      ui.set_edit_privacy(s.privacy_mode);
      ui.set_edit_reminder(s.reminder_enabled);
      ui.set_edit_reminder_min(format!("{}", s.reminder_minutes).into());
      let targets = [0usize, 1, 2, 3];
      for i in targets {
        if let Some(t) = s.targets.get(i) {
          let name = t.name.clone();
          let price = format!("{:.2}", t.price);
          match i {
            0 => { ui.set_edit_target1_name(name.into()); ui.set_edit_target1_price(price.into()); }
            1 => { ui.set_edit_target2_name(name.into()); ui.set_edit_target2_price(price.into()); }
            2 => { ui.set_edit_target3_name(name.into()); ui.set_edit_target3_price(price.into()); }
            _ => { ui.set_edit_target4_name(name.into()); ui.set_edit_target4_price(price.into()); }
          }
        }
      }
      ui.set_show_settings(true);
      ui.set_show_history(false);
    }
  };

  if std::env::args().any(|a| a == "--settings") {
    open_settings(&ui);
  }

  {
    let ui_weak = ui.as_weak();
    let db = db.clone();
    let open = open_settings;
    ui.on_open_settings(move || {
      if let Some(ui) = ui_weak.upgrade() {
        open(&ui);
      }
      let _ = &db;
    });
  }
  {
    let ui_weak = ui.as_weak();
    ui.on_close_settings(move || {
      if let Some(ui) = ui_weak.upgrade() {
        ui.set_show_settings(false);
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    let db = db.clone();
    ui.on_toggle_timer(move || {
      if let Some(ui) = ui_weak.upgrade() {
        let mut db = db.borrow_mut();
        let now = chrono::Local::now().timestamp_millis();
        if db.timer_on {
          if let Some(p) = db.pauses.last_mut() {
            if p.end.is_none() {
              p.end = Some(now);
            }
          }
          db.pauses.push(Pause { start: now, end: None });
          db.timer_on = false;
        } else {
          for p in &mut db.pauses {
            if p.end.is_none() {
              p.end = Some(now);
            }
          }
          db.timer_on = true;
        }
        db.timer_changed_at = now;
        let _ = save_db(&db);
        if let Some(float) = float_weak.upgrade() {
          refresh(&ui, &float, &db);
        }
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    let db = db.clone();
    ui.on_reset_timer(move || {
      if let Some(ui) = ui_weak.upgrade() {
        let mut db = db.borrow_mut();
        let now = chrono::Local::now().timestamp_millis();
        let snap = engine::compute(&db, now);
        if ["rest", "before", "after"].contains(&snap.status) {
          return;
        }
        db.resets.insert(snap.shift_date.clone(), now);
        db.records.retain(|r| r.work_date != snap.shift_date);
        let _ = save_db(&db);
        if let Some(float) = float_weak.upgrade() {
          refresh(&ui, &float, &db);
        }
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    ui.on_show_float(move || {
      if let Some(ui) = ui_weak.upgrade() {
        if let Some(float) = float_weak.upgrade() {
          ui.hide().unwrap();
          float.show().unwrap();
          position_float();
          let alpha = (float.get_level().clamp(0.3, 1.0) * 255.0) as u8;
          window_style("上班鼓励器 · 浮窗", true, Some(alpha));
        }
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    ui.on_open_history(move || {
      if let Some(ui) = ui_weak.upgrade() {
        ui.set_show_history(true);
        let _ = &float_weak;
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    ui.on_close_history(move || {
      if let Some(ui) = ui_weak.upgrade() {
        ui.set_show_history(false);
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    let db = db.clone();
    ui.on_save_settings(move || {
      if let Some(ui) = ui_weak.upgrade() {
        let mut db = db.borrow_mut();
        let mut s = db.latest_settings();
        s.work_start = ui.get_edit_start().to_string();
        s.work_end = ui.get_edit_end().to_string();
        s.daily_wage = ui.get_edit_daily().to_string().parse().unwrap_or(s.daily_wage);
        s.overtime_enabled = ui.get_edit_overtime();
        s.overtime_multiplier = ui.get_edit_multiplier().to_string().parse().unwrap_or(s.overtime_multiplier);
        let rate = ui.get_edit_overtime_rate().to_string().parse::<f64>().unwrap_or(0.0);
        s.overtime_hourly = if ui.get_edit_fixed() { rate } else { 0.0 };
        s.float_opacity = ui.get_edit_opacity().clamp(0.3, 1.0);
        s.always_on_top = ui.get_edit_always_on_top();
        s.decimals = ui.get_edit_decimals().to_string().parse::<u32>().unwrap_or(4).clamp(2, 6);
        s.wage_mode = ui.get_edit_mode().to_string();
        s.monthly_wage = ui.get_edit_monthly().to_string().parse().unwrap_or(s.monthly_wage);
        s.hourly_wage = ui.get_edit_hourly().to_string().parse().unwrap_or(s.hourly_wage);
        s.monthly_basis = ui.get_edit_basis().to_string();
        s.fixed_days = ui.get_edit_fixed_days().to_string().parse().unwrap_or(s.fixed_days);
        let mut weekdays = vec![];
        if ui.get_edit_mon() { weekdays.push(1); }
        if ui.get_edit_tue() { weekdays.push(2); }
        if ui.get_edit_wed() { weekdays.push(3); }
        if ui.get_edit_thu() { weekdays.push(4); }
        if ui.get_edit_fri() { weekdays.push(5); }
        if ui.get_edit_sat() { weekdays.push(6); }
        if ui.get_edit_sun() { weekdays.push(7); }
        s.weekdays = weekdays;
        s.privacy_mode = ui.get_edit_privacy();
        s.reminder_enabled = ui.get_edit_reminder();
        s.reminder_minutes = ui.get_edit_reminder_min().to_string().parse().unwrap_or(10).clamp(0, 720);
        let lunch_start = ui.get_edit_lunch_start().to_string();
        let lunch_end = ui.get_edit_lunch_end().to_string();
        if parse_hhmm(&lunch_start).is_some() && parse_hhmm(&lunch_end).is_some() && lunch_start != lunch_end {
          if s.breaks.is_empty() {
            s.breaks.push(BreakPeriod { start: lunch_start, end: lunch_end, paid: false });
          } else {
            s.breaks[0].start = lunch_start;
            s.breaks[0].end = lunch_end;
            s.breaks[0].paid = false;
          }
          s.breaks_enabled = true;
        }
        if ui.get_edit_break2() {
          let bs = ui.get_edit_break2_start().to_string();
          let be = ui.get_edit_break2_end().to_string();
          if parse_hhmm(&bs).is_some() && parse_hhmm(&be).is_some() && bs != be {
            s.breaks.push(BreakPeriod { start: bs, end: be, paid: false });
          }
        }
        let names = [
          (ui.get_edit_target1_name(), ui.get_edit_target1_price()),
          (ui.get_edit_target2_name(), ui.get_edit_target2_price()),
          (ui.get_edit_target3_name(), ui.get_edit_target3_price()),
          (ui.get_edit_target4_name(), ui.get_edit_target4_price()),
        ];
        let mut targets = vec![];
        for (name, price) in names {
          let n = name.to_string();
          let p = price.to_string().parse::<f64>().unwrap_or(0.0);
          if !n.trim().is_empty() && p > 0.0 {
            targets.push(Target { name: n, price: p });
          }
        }
        if !targets.is_empty() {
          s.targets = targets;
        }
        let now = chrono::Local::now().timestamp_millis();
        let _ = engine::save_settings(&mut db, s, now, true);
        let _ = save_db(&db);
        ui.set_show_settings(false);
        topmost("上班鼓励器", db.latest_settings().always_on_top);
        if let Some(float) = float_weak.upgrade() {
          refresh(&ui, &float, &db);
          let alpha = (float.get_level().clamp(0.3, 1.0) * 255.0) as u8;
          window_style("上班鼓励器 · 浮窗", true, Some(alpha));
        }
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    ui.on_quit_app(move || {
      ui_weak.upgrade();
      float_weak.upgrade();
      let _ = slint::quit_event_loop();
    });
  }

  {
    let ui_weak = ui.as_weak();
    ui.on_drag_window(move || {
      drag_window_title("上班鼓励器");
      let _ = &ui_weak;
    });
  }
  {
    let ui_weak = ui.as_weak();
    ui.on_minimize_window(move || {
      if let Some(ui) = ui_weak.upgrade() {
        ui.hide().unwrap();
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    ui.on_close_window(move || {
      if let Some(ui) = ui_weak.upgrade() {
        ui.hide().unwrap();
      }
    });
  }

  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    float.on_close_window(move || {
      if let Some(float) = float_weak.upgrade() {
        float.hide().unwrap();
      }
      let _ = &ui_weak;
    });
  }
  {
    let float_weak = float.as_weak();
    float.on_drag(move || {
      if float_weak.upgrade().is_some() {
        drag_float();
      }
    });
  }
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    float.on_expand(move || {
      if let Some(float) = float_weak.upgrade() {
        float.hide().unwrap();
      }
      if let Some(ui) = ui_weak.upgrade() {
        ui.show().unwrap();
        window_style("上班鼓励器", false, None);
      }
    });
  }

  let timer = Timer::default();
  {
    let ui_weak = ui.as_weak();
    let float_weak = float.as_weak();
    let db = db.clone();
    let float_positioned = std::cell::Cell::new(false);
    timer.start(TimerMode::Repeated, Duration::from_millis(200), move || {
      // 首次显示后延迟定位，等 winit 完成首帧再放到屏幕右下角
      if !float_positioned.get() {
        if let Some(f) = float_weak.upgrade() {
          if f.window().is_visible() {
            position_float();
            float_positioned.set(true);
          }
        }
      }
      while let Ok(event) = MenuEvent::receiver().try_recv() {
        match event.id.0.as_str() {
          "show" => {
            if let Some(f) = float_weak.upgrade() {
              f.hide().unwrap();
            }
            if let Some(u) = ui_weak.upgrade() {
              u.show().unwrap();
              window_style("上班鼓励器", false, None);
            }
          }
          "float" => {
            if let Some(u) = ui_weak.upgrade() {
              u.hide().unwrap();
            }
            if let Some(f) = float_weak.upgrade() {
              f.show().unwrap();
              position_float();
              let a = (f.get_level().clamp(0.3, 1.0) * 255.0) as u8;
              window_style("上班鼓励器 · 浮窗", true, Some(a));
            }
          }
          "toggle" => {
            let mut db = db.borrow_mut();
            let now = chrono::Local::now().timestamp_millis();
            db.timer_on = !db.timer_on;
            if db.timer_on {
              for p in &mut db.pauses {
                if p.end.is_none() {
                  p.end = Some(now);
                }
              }
            } else {
              db.pauses.push(Pause { start: now, end: None });
            }
            let _ = save_db(&db);
          }
          "settings" => {
            if let Some(u) = ui_weak.upgrade() {
              u.show().unwrap();
              let s = db.borrow().latest_settings();
              u.set_edit_start(s.work_start.into());
              u.set_edit_end(s.work_end.into());
              u.set_edit_opacity(s.float_opacity as f32);
              u.set_show_settings(true);
              window_style("上班鼓励器", false, None);
            }
          }
          "quit" => {
            let _ = slint::quit_event_loop();
          }
          _ => {}
        }
      }
      if let Some(u) = ui_weak.upgrade() {
        if let Some(f) = float_weak.upgrade() {
          refresh(&u, &f, &db.borrow());
          let a = (f.get_level().clamp(0.3, 1.0) * 255.0) as u8;
          window_style("上班鼓励器 · 浮窗", true, Some(a));
        }
      }
      let mut db = db.borrow_mut();
      if engine::settle(&mut db, chrono::Local::now().timestamp_millis()) {
        let _ = save_db(&db);
      }
    });
  }

  slint::run_event_loop_until_quit().unwrap();
  let _ = save_db(&db.borrow());
  let _ = timer;
}
