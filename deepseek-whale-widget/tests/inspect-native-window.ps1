param([Parameter(Mandatory=$true)][long]$Hwnd)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class InspectWhaleWindow {
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 public static int Rank(IntPtr h) { int n=0; while ((h=GetWindow(h, 3))!=IntPtr.Zero && n<10000) n++; return n; }
}
'@
$h=[IntPtr]$Hwnd
$owner=[InspectWhaleWindow]::GetWindow($h,4)
$fg=[InspectWhaleWindow]::GetForegroundWindow()
[pscustomobject]@{
 hwnd=$Hwnd; exists=[InspectWhaleWindow]::IsWindow($h); visible=[InspectWhaleWindow]::IsWindowVisible($h)
 owner=$owner.ToInt64(); topmost=([InspectWhaleWindow]::GetWindowLong($h,-20) -band 8) -ne 0
 overlayRank=[InspectWhaleWindow]::Rank($h); ownerRank=[InspectWhaleWindow]::Rank($owner)
 foreground=$fg.ToInt64(); foregroundRank=[InspectWhaleWindow]::Rank($fg)
} | ConvertTo-Json -Compress
