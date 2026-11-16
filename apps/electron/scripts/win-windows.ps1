Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> List() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
      if (!cls.ToString().Contains("Chrome_WidgetWin")) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      RECT r; GetWindowRect(h, out r);
      int ex = GetWindowLongW(h, -20);
      var owner = GetWindow(h, 4);
      res.Add(string.Format("vis={0} rect=({1},{2}) {3}x{4} layered={5} topmost={6} owner={7} title={8}",
        IsWindowVisible(h), r.L, r.T, r.R - r.L, r.B - r.T, (ex & 0x80000) != 0, (ex & 0x8) != 0, owner != IntPtr.Zero, t.ToString()));
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@ -Language CSharp
[WinEnum]::List() | ForEach-Object { $_ }
