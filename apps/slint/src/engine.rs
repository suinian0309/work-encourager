use chrono::{Datelike, Duration, Local, NaiveDate, TimeZone};

use crate::model::*;

#[derive(Clone, Copy)]
pub struct Interval {
  pub start: i64,
  pub end: i64,
}

fn merge(mut list: Vec<Interval>) -> Vec<Interval> {
  list.retain(|i| i.end > i.start);
  list.sort_by_key(|i| i.start);
  let mut out: Vec<Interval> = vec![];
  for item in list {
    if let Some(last) = out.last_mut() {
      if item.start <= last.end {
        last.end = last.end.max(item.end);
        continue;
      }
    }
    out.push(item);
  }
  out
}

fn subtract(base: &[Interval], holes: &[Interval]) -> Vec<Interval> {
  let holes = merge(holes.to_vec());
  let mut out = vec![];
  for piece in merge(base.to_vec()) {
    let mut cursor = piece.start;
    for hole in &holes {
      if hole.end <= cursor {
        continue;
      }
      if hole.start >= piece.end {
        break;
      }
      if hole.start > cursor {
        out.push(Interval { start: cursor, end: hole.start.min(piece.end) });
      }
      cursor = cursor.max(hole.end);
      if cursor >= piece.end {
        break;
      }
    }
    if cursor < piece.end {
      out.push(Interval { start: cursor, end: piece.end });
    }
  }
  out
}

fn clip(list: &[Interval], start: i64, end: i64) -> Vec<Interval> {
  list
    .iter()
    .map(|i| Interval { start: i.start.max(start), end: i.end.min(end) })
    .filter(|i| i.end > i.start)
    .collect()
}

fn total(seconds: &[Interval]) -> f64 {
  seconds.iter().map(|i| (i.end - i.start) as f64 / 1000.0).sum()
}

#[derive(Clone)]
pub struct Shift {
  pub work_date: String,
  pub start: i64,
  pub end: i64,
  pub paid: Vec<Interval>,
  pub unpaid: Vec<Interval>,
  pub paid_seconds: f64,
  pub crosses: bool,
  pub settings: Settings,
}

pub fn build_shift(settings: &Settings, date: NaiveDate) -> Option<Shift> {
  if !is_workday(settings, date) {
    return None;
  }
  let start_m = parse_hhmm(&settings.work_start)?;
  let end_m = parse_hhmm(&settings.work_end)?;
  let len = if end_m > start_m { end_m - start_m } else { end_m + 1440 - start_m };
  if len == 0 {
    return None;
  }
  let start = local_ms(date, start_m)?;
  let end = start + len as i64 * 60_000;
  let mut unpaid = vec![];
  if settings.breaks_enabled {
    for br in &settings.breaks {
      let bs = parse_hhmm(&br.start)?;
      let be = parse_hhmm(&br.end)?;
      let dur = if be > bs { be - bs } else { be + 1440 - bs };
      let offset = (bs + 1440 - start_m) % 1440;
      if dur == 0 || offset + dur > len {
        continue;
      }
      let s = start + offset as i64 * 60_000;
      let e = s + dur as i64 * 60_000;
      if !br.paid {
        unpaid.push(Interval { start: s, end: e });
      }
    }
  }
  let unpaid = merge(unpaid);
  let paid = subtract(&[Interval { start, end }], &unpaid);
  let paid_seconds = total(&paid);
  Some(Shift {
    work_date: date.format("%Y-%m-%d").to_string(),
    start,
    end,
    paid,
    unpaid,
    paid_seconds,
    crosses: end > local_ms(date + Duration::days(1), 0).unwrap_or(i64::MAX),
    settings: settings.clone(),
  })
}

pub fn accrued_seconds(shift: &Shift, pauses: &[Pause], reset: Option<i64>, now: i64) -> f64 {
  let until = now.min(shift.end);
  let start = reset.unwrap_or(shift.start).max(shift.start);
  if until <= start {
    return 0.0;
  }
  let base = clip(&shift.paid, start, until);
  let holes: Vec<Interval> = pauses
    .iter()
    .map(|p| Interval { start: p.start.max(start), end: p.end.unwrap_or(until).min(until) })
    .filter(|i| i.end > i.start)
    .collect();
  total(&subtract(&base, &holes)).max(0.0)
}

pub const OVERTIME_MAX_HOURS: f64 = 8.0;

pub fn overtime_seconds(shift: &Shift, pauses: &[Pause], reset: Option<i64>, now: i64) -> f64 {
  if now <= shift.end {
    return 0.0;
  }
  let start = shift.end.max(reset.unwrap_or(0));
  let until = now.min(shift.end + (OVERTIME_MAX_HOURS * 3_600_000.0) as i64);
  if until <= start {
    return 0.0;
  }
  let base = vec![Interval { start, end: until }];
  let holes: Vec<Interval> = pauses
    .iter()
    .map(|p| Interval { start: p.start.max(start), end: p.end.unwrap_or(until).min(until) })
    .filter(|i| i.end > i.start)
    .collect();
  total(&subtract(&base, &holes)).max(0.0)
}

pub fn workdays_in_month(settings: &Settings, date: NaiveDate) -> u32 {
  let first = NaiveDate::from_ymd_opt(date.year(), date.month(), 1).unwrap();
  (1..=31)
    .filter_map(|d| first.with_day(d))
    .filter(|d| d.month() == date.month() && is_workday(settings, *d))
    .count() as u32
}

pub struct Wage {
  pub per_second: f64,
  pub hourly: f64,
  pub daily: f64,
  pub basis: String,
}

pub fn wage(settings: &Settings, shift: &Shift) -> Wage {
  let safe = shift.paid_seconds.max(1.0);
  let mut daily = settings.daily_wage;
  let mut basis;
  match settings.wage_mode.as_str() {
    "monthly" => {
      let days = if settings.monthly_basis == "fixed" {
        settings.fixed_days.max(0.01)
      } else {
        let d = workdays_in_month(settings, NaiveDate::parse_from_str(&shift.work_date, "%Y-%m-%d").unwrap()).max(1);
        d as f64
      };
      daily = settings.monthly_wage / days.max(0.01);
      basis = format!("月薪 ¥{:.2} ÷ {} 天", settings.monthly_wage, days);
    }
    "hourly" => {
      daily = settings.hourly_wage * safe / 3600.0;
      basis = format!("时薪 ¥{:.2}", settings.hourly_wage);
    }
    _ => {
      basis = format!("日薪 ¥{:.2} ÷ {:.2} 小时", daily, safe / 3600.0);
    }
  }
  let hourly = if settings.wage_mode == "hourly" {
    settings.hourly_wage
  } else {
    daily / (safe / 3600.0).max(0.01)
  };
  if settings.wage_mode == "hourly" {
    basis = format!("时薪 ¥{:.2}", settings.hourly_wage);
    daily = hourly * safe / 3600.0;
  }
  Wage { per_second: daily / safe, hourly, daily, basis }
}

pub fn overtime_rate(settings: &Settings, base: &Wage) -> f64 {
  let hourly = if settings.overtime_hourly > 0.0 { settings.overtime_hourly } else { base.hourly };
  hourly * settings.overtime_multiplier.max(0.01)
}

pub struct Snapshot {
  pub status: &'static str,
  pub status_label: String,
  pub date_text: String,
  pub time_text: String,
  pub countdown_title: String,
  pub countdown_text: String,
  pub hint: String,
  pub earn_today: f64,
  pub base_income: f64,
  pub overtime_income: f64,
  pub overtime_seconds: f64,
  pub rate: f64,
  pub overtime_rate: f64,
  pub progress: f64,
  pub base_seconds: f64,
  pub planned_seconds: f64,
  pub month_total: f64,
  pub month_days: u32,
  pub encouragement: String,
  pub shift_date: String,
  pub notice: String,
  pub hourly: f64,
  pub daily: f64,
  pub basis: String,
}

fn money(value: f64, decimals: u32) -> String {
  let s = format!("{:.*}", decimals as usize, value);
  let (int, frac) = s.split_once('.').unwrap_or((&s, ""));
  let mut grouped = String::new();
  for (i, ch) in int.chars().rev().enumerate() {
    if i > 0 && i % 3 == 0 {
      grouped.push(',');
    }
    grouped.push(ch);
  }
  let int: String = grouped.chars().rev().collect();
  if frac.is_empty() { int } else { format!("{int}.{frac}") }
}

fn fmt_duration(ms: i64) -> String {
  let secs = (ms.max(0) + 999) / 1000;
  format!("{:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
}

fn records_for_month<'a>(db: &'a Db, month: &str) -> Vec<&'a DayRecord> {
  db.records.iter().filter(|r| r.work_date.starts_with(month)).collect()
}

pub fn compute(db: &Db, now_ms: i64) -> Snapshot {
  let now = Local.timestamp_millis_opt(now_ms).single().unwrap_or_else(Local::now);
  let today = now.date_naive();
  let today_key = today.format("%Y-%m-%d").to_string();
  let yesterday = today - Duration::days(1);
  let today_shift = build_shift(&db.settings_for(&today_key), today);
  let y_shift = build_shift(&db.settings_for(&yesterday.format("%Y-%m-%d").to_string()), yesterday);
  let active = today_shift
    .as_ref()
    .filter(|s| now_ms >= s.start && now_ms < s.end)
    .cloned()
    .or_else(|| y_shift.clone().filter(|s| now_ms >= s.start && now_ms < s.end));
  let display = active.clone().or(today_shift.clone());
  let settings = display
    .as_ref()
    .map(|s| s.settings.clone())
    .unwrap_or_else(|| db.settings_for(&today_key));

  let record = display
    .as_ref()
    .and_then(|s| db.records.iter().find(|r| r.work_date == s.work_date));

  let mut base_seconds = 0.0;
  let mut ot_seconds = 0.0;
  if let Some(shift) = &display {
    base_seconds = accrued_seconds(shift, &db.pauses, db.resets.get(&shift.work_date).copied(), now_ms);
    if settings.overtime_enabled {
      ot_seconds = overtime_seconds(shift, &db.pauses, db.resets.get(&shift.work_date).copied(), now_ms);
    }
  }

  let mut base_income = 0.0;
  let mut ot_income = 0.0;
  let w = if let Some(shift) = display.as_ref() {
    wage(&settings, shift)
  } else {
    Wage {
      per_second: 0.0,
      hourly: settings.hourly_wage,
      daily: settings.daily_wage,
      basis: "今日休息".into(),
    }
  };
  if let Some(r) = record {
    base_income = r.base_income;
    ot_income = r.overtime_income;
    base_seconds = r.base_seconds;
    ot_seconds = r.overtime_seconds;
  } else if display.is_some() {
    base_income = w.per_second * base_seconds;
    if base_income > w.daily {
      base_income = w.daily;
    }
    ot_income = overtime_rate(&settings, &w) * ot_seconds / 3600.0;
  }

  let total_income = base_income + ot_income;
  let planned = display.as_ref().map(|s| s.paid_seconds).unwrap_or(0.0);
  let progress = if planned > 0.0 { (base_seconds / planned).clamp(0.0, 1.0) } else { 0.0 };
  let in_ot = display
    .as_ref()
    .map(|s| settings.overtime_enabled && now_ms >= s.end)
    .unwrap_or(false);

  let status = if !db.timer_on {
    "paused"
  } else if display.is_none() {
    "rest"
  } else if in_ot {
    "overtime"
  } else if active.is_none() {
    if today_shift.as_ref().map(|s| now_ms < s.start).unwrap_or(false) {
      "before"
    } else {
      "after"
    }
  } else if display.as_ref().map(|s| s.unpaid.iter().any(|u| now_ms >= u.start && now_ms < u.end)).unwrap_or(false) {
    "break"
  } else {
    "working"
  };
  let label = match status {
    "paused" => "计时已关闭",
    "rest" => "今日休息",
    "overtime" => "加班中",
    "before" => "未上班",
    "after" => "已下班",
    "break" => "休息中",
    _ => "上班中",
  };

  let (title, text, hint) = if status == "overtime" {
    let elapsed = display.as_ref().map(|s| now_ms - s.end).unwrap_or(0);
    ("已加班".to_string(), fmt_duration(elapsed), "加班薪资按设置的时薪 × 倍数计算".to_string())
  } else if status == "rest" {
    ("今天休息".to_string(), "休息日".to_string(), "不用上班，好好放松".to_string())
  } else if status == "before" {
    if let Some(s) = &today_shift {
      ("距上班还有".to_string(), fmt_duration(s.start - now_ms), format!("上班时间 {}", s.settings.work_start))
    } else {
      ("今天休息".to_string(), "休息日".to_string(), "".to_string())
    }
  } else if status == "after" {
    ("今天已下班".to_string(), "辛苦啦".to_string(), "今天的努力已经到账".to_string())
  } else if status == "paused" {
    ("计时已关闭".to_string(), "收入暂停".to_string(), "开启计时器后继续累计".to_string())
  } else {
    let remain = display.as_ref().map(|s| s.end - now_ms).unwrap_or(0);
    ("距下班还有".to_string(), fmt_duration(remain), display.as_ref().map(|s| format!("下班时间 {}", s.settings.work_end)).unwrap_or_default())
  };

  let month = today_key[..7].to_string();
  let month_records = records_for_month(db, &month);
  let mut month_total: f64 = month_records.iter().map(|r| r.income).sum();
  if !record.is_some() {
    if let Some(s) = &display {
      if s.work_date.starts_with(&month) {
        month_total += total_income;
      }
    }
  }
  let month_days = month_records.len() as u32 + if record.is_none() && display.is_some() { 1 } else { 0 };

  let base_rate = if status == "working" { w.per_second } else { 0.0 };
  let ot_rate = overtime_rate(&settings, &w);
  let rate = if status == "overtime" { ot_rate / 3600.0 } else { base_rate };
  let encouragement = if status == "overtime" {
    format!("加班中，已加班 {}，加班收入 ¥{}。", fmt_duration((ot_seconds * 1000.0) as i64), money(ot_income, 2))
  } else if status == "paused" {
    "计时已关闭，收入暂停累计。".into()
  } else if status == "after" {
    "下班啦，今天的努力已经到账！".into()
  } else if status == "break" {
    "休息中，吃饱喝足再继续。".into()
  } else if status == "working" {
    if let Some(t) = settings.targets.first() {
      let need = t.price - total_income % t.price;
      let secs = if rate > 0.0 { need / rate } else { 0.0 };
      if secs < 8.0 * 3600.0 {
        format!("再过 {} 分钟，一份{}就赚回来了。", (secs / 60.0).ceil().max(1.0) as i64, t.name)
      } else {
        "稳住节奏，今天的每一分钟都在入账。".into()
      }
    } else {
      "稳住节奏，今天的每一分钟都在入账。".into()
    }
  } else {
    "稳住节奏，今天的每一分钟都在入账。".into()
  };

  let notice = if settings.privacy_mode {
    "隐私模式已开启".into()
  } else if settings.overtime_enabled && in_ot {
    format!("加班 ¥{:.2}/小时 · {} 倍", overtime_rate(&settings, &w), settings.overtime_multiplier)
  } else {
    format!("本月已计 {} 个工作日", month_days)
  };

  Snapshot {
    status,
    status_label: label.into(),
    date_text: format!(
      "{}年{}月{}日 · 星期{}",
      today.year(),
      today.month(),
      today.day(),
      ["一", "二", "三", "四", "五", "六", "日"][today.weekday().num_days_from_monday() as usize]
    ),
    time_text: now.format("%H:%M:%S").to_string(),
    countdown_title: title.into(),
    countdown_text: text,
    hint,
    earn_today: total_income,
    base_income,
    overtime_income: ot_income,
    overtime_seconds: ot_seconds,
    rate,
    overtime_rate: ot_rate,
    progress,
    base_seconds,
    planned_seconds: planned,
    month_total,
    month_days,
    encouragement,
    shift_date: display.as_ref().map(|s| s.work_date.clone()).unwrap_or_default(),
    notice,
    hourly: w.hourly,
    daily: w.daily,
    basis: w.basis.clone(),
  }
}

pub fn settle(db: &mut Db, now: i64) -> bool {
  let today = Local.timestamp_millis_opt(now).single().unwrap_or_else(Local::now).date_naive();
  let start = NaiveDate::parse_from_str(&db.first_run_date, "%Y-%m-%d").unwrap_or(today);
  let mut day = start;
  let mut changed = false;
  while day <= today {
    let key = day.format("%Y-%m-%d").to_string();
    if !db.records.iter().any(|r| r.work_date == key) {
      let settings = db.settings_for(&key);
      if let Some(shift) = build_shift(&settings, day) {
        let cutoff = shift.end + if settings.overtime_enabled { (OVERTIME_MAX_HOURS * 3_600_000.0) as i64 } else { 0 };
        if now >= cutoff {
          let base_sec = accrued_seconds(&shift, &db.pauses, db.resets.get(&key).copied(), cutoff);
          let ot_sec = if settings.overtime_enabled {
            overtime_seconds(&shift, &db.pauses, db.resets.get(&key).copied(), cutoff)
          } else {
            0.0
          };
          let w = wage(&settings, &shift);
          let mut base = w.per_second * base_sec;
          if base > w.daily {
            base = w.daily;
          }
          let ot = overtime_rate(&settings, &w) * ot_sec / 3600.0;
          db.records.push(DayRecord {
            work_date: key.clone(),
            base_income: (base * 100.0).round() / 100.0,
            overtime_income: (ot * 100.0).round() / 100.0,
            income: ((base + ot) * 100.0).round() / 100.0,
            base_seconds: base_sec,
            overtime_seconds: ot_sec,
            scheduled_seconds: shift.paid_seconds,
            basis: w.basis,
            wage_mode: settings.wage_mode,
            settled_at: now,
          });
          changed = true;
        }
      }
    }
    day += Duration::days(1);
  }
  changed
}

pub fn save_settings(db: &mut Db, settings: Settings, now: i64, apply_current: bool) -> Result<(), String> {
  let now_local = Local.timestamp_millis_opt(now).single().unwrap_or_else(Local::now);
  let today = now_local.date_naive().format("%Y-%m-%d").to_string();
  let resolved = compute(db, now);
  let effective = if apply_current {
    if resolved.shift_date.is_empty() { today.clone() } else { resolved.shift_date.clone() }
  } else {
    let s = db.settings_for(&today);
    let shift = build_shift(&s, now_local.date_naive());
    if let Some(shift) = shift {
      if now >= shift.start {
        (now_local.date_naive() + Duration::days(1)).format("%Y-%m-%d").to_string()
      } else {
        today.clone()
      }
    } else {
      today.clone()
    }
  };
  db.settings_timeline.retain(|e| e.effective_from < effective);
  db.settings_timeline.push(SettingsEntry { effective_from: effective.clone(), settings });
  if apply_current {
    db.records.retain(|r| r.work_date != effective);
  }
  save_db(db)?;
  Ok(())
}

pub fn month_key(date: &str) -> &str {
  if date.len() >= 7 { &date[..7] } else { date }
}

pub fn current_month_records(db: &Db) -> Vec<&DayRecord> {
  let month = today_key()[..7].to_string();
  db.records.iter().filter(|r| r.work_date.starts_with(&month)).collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::TimeZone;

  fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
    Local.with_ymd_and_hms(y, m, d, h, min, 0).unwrap().timestamp_millis()
  }

  #[test]
  fn daily_wage_and_overtime() {
    let mut db = Db::new(at(2026, 11, 10, 8, 0));
    db.settings_timeline[0].effective_from = "2026-11-01".into();
    let morning = compute(&db, at(2026, 11, 10, 10, 0));
    assert_eq!(morning.status, "working");
    assert!((morning.earn_today - 17.142857).abs() < 0.001, "{}", morning.earn_today);
    assert!((morning.progress - 1.0 / 7.0).abs() < 0.002);
    let evening = compute(&db, at(2026, 11, 10, 18, 0));
    assert_eq!(evening.status, "overtime");
    assert!((evening.base_income - 120.0).abs() < 0.01);
    assert!((evening.overtime_income - 25.714285).abs() < 0.01, "{}", evening.overtime_income);
    assert!((evening.earn_today - 145.714285).abs() < 0.01);
    assert!((evening.rate - 25.714285 / 3600.0).abs() < 1e-6);
  }

  #[test]
  fn overtime_disabled_stops_at_day_wage() {
    let mut db = Db::new(at(2026, 11, 10, 8, 0));
    db.settings_timeline[0].effective_from = "2026-11-01".into();
    db.settings_timeline[0].settings.overtime_enabled = false;
    let evening = compute(&db, at(2026, 11, 10, 20, 0));
    assert_eq!(evening.status, "after");
    assert!((evening.earn_today - 120.0).abs() < 0.01);
    assert_eq!(evening.overtime_income, 0.0);
  }

  #[test]
  fn custom_overtime_rate_and_multiplier() {
    let mut db = Db::new(at(2026, 11, 10, 8, 0));
    db.settings_timeline[0].effective_from = "2026-11-01".into();
    db.settings_timeline[0].settings.overtime_hourly = 40.0;
    db.settings_timeline[0].settings.overtime_multiplier = 2.0;
    let evening = compute(&db, at(2026, 11, 10, 18, 0));
    assert!((evening.overtime_income - 80.0).abs() < 0.01);
    assert!((evening.earn_today - 200.0).abs() < 0.01);
  }
}
