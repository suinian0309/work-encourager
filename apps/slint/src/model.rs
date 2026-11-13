use chrono::{Datelike, Local, NaiveDate, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
pub struct BreakPeriod {
  pub start: String,
  pub end: String,
  pub paid: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SpecialDay {
  pub date: String,
  #[serde(rename = "type")]
  pub kind: String, // work | off
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Target {
  pub name: String,
  pub price: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
  pub wage_mode: String, // daily | monthly | hourly
  pub daily_wage: f64,
  pub monthly_wage: f64,
  pub hourly_wage: f64,
  pub monthly_basis: String, // actual | fixed
  pub fixed_days: f64,
  pub work_start: String,
  pub work_end: String,
  pub weekdays: Vec<u32>,
  pub breaks_enabled: bool,
  pub breaks: Vec<BreakPeriod>,
  pub special_days: Vec<SpecialDay>,
  pub targets: Vec<Target>,
  pub theme: String, // system | light | dark
  pub always_on_top: bool,
  pub minimize_to_tray: bool,
  pub close_action: String, // quit | tray
  pub reminder_enabled: bool,
  pub reminder_minutes: i64,
  pub decimals: u32,
  pub privacy_mode: bool,
  pub overtime_enabled: bool,
  pub overtime_hourly: f64, // 0 => 按基础时薪
  pub overtime_multiplier: f64,
  #[serde(default = "default_float_opacity")]
  pub float_opacity: f32,
  pub floating: bool,
}

fn default_float_opacity() -> f32 {
  0.92
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      wage_mode: "daily".into(),
      daily_wage: 120.0,
      monthly_wage: 8000.0,
      hourly_wage: 60.0,
      monthly_basis: "actual".into(),
      fixed_days: 21.75,
      work_start: "09:00".into(),
      work_end: "17:00".into(),
      weekdays: vec![1, 2, 3, 4, 5],
      breaks_enabled: true,
      breaks: vec![BreakPeriod {
        start: "12:00".into(),
        end: "13:00".into(),
        paid: false,
      }],
      special_days: vec![],
      targets: vec![
        Target { name: "奶茶".into(), price: 18.0 },
        Target { name: "咖啡".into(), price: 20.0 },
        Target { name: "午饭".into(), price: 25.0 },
        Target { name: "晚饭".into(), price: 35.0 },
      ],
      theme: "system".into(),
      always_on_top: false,
      minimize_to_tray: true,
      close_action: "tray".into(),
      reminder_enabled: true,
      reminder_minutes: 10,
      decimals: 4,
      privacy_mode: false,
      overtime_enabled: true,
      overtime_hourly: 0.0,
      overtime_multiplier: 1.5,
      float_opacity: 0.92,
      floating: false,
    }
  }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SettingsEntry {
  pub effective_from: String,
  pub settings: Settings,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Pause {
  pub start: i64,
  pub end: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DayRecord {
  pub work_date: String,
  pub base_income: f64,
  pub overtime_income: f64,
  pub income: f64,
  pub base_seconds: f64,
  pub overtime_seconds: f64,
  pub scheduled_seconds: f64,
  pub basis: String,
  pub wage_mode: String,
  pub settled_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Db {
  pub version: u32,
  pub created_at: i64,
  pub first_run_date: String,
  pub settings_timeline: Vec<SettingsEntry>,
  pub timer_on: bool,
  pub timer_changed_at: i64,
  pub pauses: Vec<Pause>,
  pub resets: HashMap<String, i64>,
  pub records: Vec<DayRecord>,
  pub fired: Vec<String>,
}

fn date_key(d: NaiveDate) -> String {
  d.format("%Y-%m-%d").to_string()
}

pub fn today_key() -> String {
  date_key(Local::now().date_naive())
}

impl Db {
  pub fn new(now_ms: i64) -> Self {
    let today = today_key();
    Self {
      version: 1,
      created_at: now_ms,
      first_run_date: today.clone(),
      settings_timeline: vec![SettingsEntry {
        effective_from: today,
        settings: Settings::default(),
      }],
      timer_on: true,
      timer_changed_at: now_ms,
      pauses: vec![],
      resets: HashMap::new(),
      records: vec![],
      fired: vec![],
    }
  }

  pub fn settings_for(&self, date: &str) -> Settings {
    let mut chosen = self
      .settings_timeline
      .first()
      .map(|e| e.settings.clone())
      .unwrap_or_default();
    for entry in &self.settings_timeline {
      if entry.effective_from.as_str() <= date {
        chosen = entry.settings.clone();
      }
    }
    chosen
  }

  pub fn latest_settings(&self) -> Settings {
    self
      .settings_timeline
      .last()
      .map(|e| e.settings.clone())
      .unwrap_or_default()
  }
}

pub fn data_path() -> PathBuf {
  if let Ok(dir) = std::env::var("WORK_ENC_DATA_DIR") {
    return PathBuf::from(dir).join("work-encourager-native.json");
  }
  let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
  base.join("WorkEncouragerNative").join("work-encourager-native.json")
}

pub fn load_db() -> Result<Db, String> {
  let path = data_path();
  if !path.exists() {
    return Ok(Db::new(Local::now().timestamp_millis()));
  }
  let text = fs::read_to_string(&path).map_err(|e| format!("读取数据失败 {}：{e}", path.display()))?;
  serde_json::from_str(&text).map_err(|e| format!("数据格式异常 {}：{e}", path.display()))
}

pub fn save_db(db: &Db) -> Result<(), String> {
  let path = data_path();
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
  }
  let text = serde_json::to_string_pretty(db).map_err(|e| format!("序列化失败：{e}"))?;
  let tmp = path.with_extension("tmp");
  fs::write(&tmp, text).map_err(|e| format!("写入临时文件失败：{e}"))?;
  if path.exists() {
    let _ = fs::remove_file(path.with_extension("bak"));
    let _ = fs::rename(&path, path.with_extension("bak"));
  }
  fs::rename(&tmp, &path).map_err(|e| format!("替换数据文件失败：{e}"))?;
  let _ = fs::remove_file(path.with_extension("bak"));
  Ok(())
}

pub fn parse_hhmm(value: &str) -> Option<u32> {
  let (h, m) = value.split_once(':')?;
  let h: u32 = h.parse().ok()?;
  let m: u32 = m.parse().ok()?;
  if h > 23 || m > 59 {
    return None;
  }
  Some(h * 60 + m)
}

pub fn hhmm(minutes: u32) -> String {
  let m = minutes % 1440;
  format!("{:02}:{:02}", m / 60, m % 60)
}

pub fn local_ms(date: NaiveDate, minutes: u32) -> Option<i64> {
  let time = NaiveTime::from_hms_opt(minutes / 60, minutes % 60, 0)?;
  Local
    .from_local_datetime(&date.and_time(time))
    .single()
    .map(|d| d.timestamp_millis())
}

pub fn is_workday(settings: &Settings, date: NaiveDate) -> bool {
  let key = date_key(date);
  if let Some(special) = settings.special_days.iter().find(|s| s.date == key) {
    return special.kind == "work";
  }
  let wd = date.weekday().number_from_monday();
  settings.weekdays.contains(&wd)
}

pub fn settings_for_day(settings: &Settings, date: NaiveDate) -> bool {
  is_workday(settings, date)
}
