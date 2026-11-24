//! 版本检查与更新（Tauri 侧）。
//!
//! 刻意不引入 reqwest：Windows 10 1803 起自带 curl.exe，
//! 用它拉 Release JSON 和安装包，二进制体积不变，行为也够用。
//!
//! GitHub 未登录的 API 每小时只给 60 次，很容易被限流，
//! 所以 API 失败时会退回到 releases/latest 的 302 重定向 + 稳定直链。

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const UPDATE_REPO: &str = "suinian0309/work-encourager";
const USER_AGENT: &str = "work-encourager-updater";

#[derive(Serialize, Clone)]
pub struct UpdateAsset {
    pub name: String,
    pub size: u64,
    pub url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub notes: String,
    pub published_at: String,
    pub page_url: String,
    pub asset: Option<UpdateAsset>,
    pub checked_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: String,
    pub received: u64,
    pub total: u64,
    pub percent: u32,
}

fn curl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("curl.exe")
        .args(args)
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("调用 curl 失败：{e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("curl 退出码 {:?}", output.status.code())
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_version(input: &str) -> Vec<u64> {
    input
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn compare_versions(a: &str, b: &str) -> i32 {
    let left = parse_version(a);
    let right = parse_version(b);
    let len = left.len().max(right.len());
    for i in 0..len {
        let l = *left.get(i).unwrap_or(&0);
        let r = *right.get(i).unwrap_or(&0);
        if l != r {
            return if l > r { 1 } else { -1 };
        }
    }
    0
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn pick_installer(assets: &[UpdateAsset]) -> Option<UpdateAsset> {
    let msi: Vec<&UpdateAsset> = assets
        .iter()
        .filter(|item| item.name.to_lowercase().ends_with(".msi"))
        .collect();
    if msi.is_empty() {
        return None;
    }
    if let Some(tauri) = msi
        .iter()
        .find(|item| item.name.to_lowercase().contains("tauri"))
    {
        return Some((*tauri).clone());
    }
    let fallback = msi
        .iter()
        .find(|item| !item.name.to_lowercase().contains("electron"));
    fallback.map(|item| (*item).clone())
}

fn check_via_api(current_version: &str) -> Result<UpdateInfo, String> {
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases?per_page=10");
    let body = curl(&[
        "-sS",
        "-L",
        "--fail",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        &format!("User-Agent: {USER_AGENT}"),
        &url,
    ])?;

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 GitHub 响应失败：{e}"))?;
    let list = json
        .as_array()
        .ok_or_else(|| "GitHub 返回的不是 Release 列表".to_string())?;

    let release = list
        .iter()
        .find(|item| {
            !item
                .get("draft")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                && !item
                    .get("prerelease")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
        })
        .or_else(|| list.first())
        .ok_or_else(|| "这个仓库还没有可用的 Release".to_string())?;

    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if tag.is_empty() {
        return Err("Release 上没有版本号".into());
    }

    let assets: Vec<UpdateAsset> = release
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(UpdateAsset {
                        name: item.get("name")?.as_str()?.to_string(),
                        size: item.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                        url: item.get("browser_download_url")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(UpdateInfo {
        current_version: current_version.to_string(),
        latest_version: tag.clone(),
        has_update: compare_versions(&tag, current_version) > 0,
        notes: release
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(4000)
            .collect(),
        published_at: release
            .get("published_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        page_url: release
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(|text| text.to_string())
            .unwrap_or_else(|| format!("https://github.com/{UPDATE_REPO}/releases")),
        asset: pick_installer(&assets),
        checked_at: now_ms(),
    })
}

/// 兜底：走 releases/latest 的 302 拿 tag，再用稳定直链下载（不耗 API 配额）
fn check_via_redirect(current_version: &str) -> Result<UpdateInfo, String> {
    let latest_page = format!("https://github.com/{UPDATE_REPO}/releases/latest");
    let final_url = curl(&[
        "-sS",
        "-L",
        "-o",
        "NUL",
        "-w",
        "%{url_effective}",
        "-H",
        &format!("User-Agent: {USER_AGENT}"),
        &latest_page,
    ])?;
    let marker = "/releases/tag/";
    let tag = final_url
        .split(marker)
        .nth(1)
        .map(|rest| rest.split(['?', '#']).next().unwrap_or("").to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "拿不到最新版本号（releases/latest 没有重定向）".to_string())?;
    let tag = tag.trim_start_matches(['v', 'V']).to_string();

    let asset_name = format!("WorkEncourager-Tauri-Setup-{tag}.msi");
    Ok(UpdateInfo {
        current_version: current_version.to_string(),
        latest_version: tag.clone(),
        has_update: compare_versions(&tag, current_version) > 0,
        notes: String::new(),
        published_at: String::new(),
        page_url: format!("https://github.com/{UPDATE_REPO}/releases/tag/v{tag}"),
        asset: Some(UpdateAsset {
            name: asset_name.clone(),
            size: 0,
            url: format!("https://github.com/{UPDATE_REPO}/releases/latest/download/{asset_name}"),
        }),
        checked_at: now_ms(),
    })
}

#[tauri::command]
pub async fn check_update(_app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    match check_via_api(&current_version) {
        Ok(info) => Ok(info),
        Err(api_error) => check_via_redirect(&current_version)
            .map_err(|fallback_error| format!("{api_error}；兜底也失败：{fallback_error}")),
    }
}

fn update_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("work-encourager-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败：{e}"))?;
    Ok(dir)
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    name: String,
) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("下载地址必须是 https".into());
    }
    let safe_name = name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let target = update_dir()?.join(safe_name);
    let _ = std::fs::remove_file(&target);
    let target_arg = target.to_string_lossy().to_string();

    let mut child = Command::new("curl.exe")
        .args([
            "-sS",
            "-L",
            "--fail",
            "-H",
            &format!("User-Agent: {USER_AGENT}"),
            "-o",
            &target_arg,
            &url,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动下载失败：{e}"))?;

    // curl 不给机器可读进度，就自己看文件增长
    let monitor_app = app.clone();
    let monitor_path = target.clone();
    let monitor = std::thread::spawn(move || {
        let mut last = 0u64;
        let mut idle = 0u32;
        loop {
            let size = std::fs::metadata(&monitor_path)
                .map(|m| m.len())
                .unwrap_or(0);
            let _ = monitor_app.emit(
                "update-progress",
                UpdateProgress {
                    phase: "download".into(),
                    received: size,
                    total: 0,
                    percent: 0,
                },
            );
            if size == last {
                idle += 1;
            } else {
                idle = 0;
                last = size;
            }
            // 连续 6 次（约 2.4s）没有增长，说明下载已结束或卡住，退出监视
            if idle >= 6 {
                break;
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    });

    let status = child.wait().map_err(|e| format!("等待下载失败：{e}"))?;
    let _ = monitor.join();

    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut stderr, &mut err);
        }
        return Err(if err.trim().is_empty() {
            format!("下载失败，curl 退出码 {:?}", status.code())
        } else {
            err.trim().to_string()
        });
    }

    let size = std::fs::metadata(&target)
        .map_err(|e| format!("下载完成但读不到文件：{e}"))?
        .len();
    if size == 0 {
        return Err("下载完成但文件是空的".into());
    }
    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            phase: "download".into(),
            received: size,
            total: size,
            percent: 100,
        },
    );
    Ok(target_arg)
}

#[tauri::command]
pub async fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !file.exists() {
        return Err("安装包不存在，请重新下载".into());
    }
    // /passive：自带进度条不打扰；/norestart：不擅自重启系统
    Command::new("msiexec")
        .args(["/i", &file.to_string_lossy(), "/passive", "/norestart"])
        .spawn()
        .map_err(|e| format!("启动安装失败：{e}"))?;
    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            phase: "install".into(),
            received: 0,
            total: 0,
            percent: 0,
        },
    );
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
pub async fn open_release(url: String) -> Result<(), String> {
    let target = if url.starts_with("https://") {
        url
    } else {
        format!("https://github.com/{UPDATE_REPO}/releases")
    };
    Command::new("cmd")
        .args(["/c", "start", "", &target])
        .spawn()
        .map_err(|e| format!("打开浏览器失败：{e}"))?;
    Ok(())
}
