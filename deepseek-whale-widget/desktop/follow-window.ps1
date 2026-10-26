# Reports the ZCode main window CLIENT AREA so the overlay viewport equals the
# chat area. See desktop/main.cjs for the message contract.
#
#   {"x":..,"y":..,"w":..,"h":..,"show":bool,"minimized":bool,"pid":N,"pidStart":MS}
#   {"hide":true}   ZCode window not found (restart / startup window gap).
#   {"gone":true}   ZCode process exited; the overlay should quit.
#
# Keep this file pure ASCII (Windows PowerShell 5.1 decodes BOM-less scripts with
# the system ANSI code page).
param(
  [Parameter(Mandatory = $true)][string]$OverlayHwnd,
  [int]$IntervalMs = 40,
  [int]$ProcessCacheMs = 3000,
  [int]$OverlayPid = 0
)

$ErrorActionPreference = 'SilentlyContinue'

if ($IntervalMs -lt 16) { $IntervalMs = 16 }
if ($IntervalMs -gt 2000) { $IntervalMs = 2000 }
if ($ProcessCacheMs -lt 500) { $ProcessCacheMs = 500 }

$targetProcess = if ($env:DEEPSEEK_WHALE_TARGET_PROCESS) { $env:DEEPSEEK_WHALE_TARGET_PROCESS } else { 'ZCode' }

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WhaleFollow
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public int Length; public int Flags; public int ShowCmd;
        public POINT MinPosition; public POINT MaxPosition; public RECT NormalPosition;
    }
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);

    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int val, int size);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);

    static bool SyncOverlayOrder(IntPtr host)
    {
        const uint SWP_KEEP_GEOMETRY_AND_FOCUS = 0x0013; // NOSIZE | NOMOVE | NOACTIVATE
        const uint SWP_NOOWNERZORDER = 0x0200;
        if (GetWindow(_overlayHwnd, 4 /* GW_OWNER */) != host)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(_overlayHwnd, -8 /* GWLP_HWNDPARENT */, host);
            else SetWindowLong(_overlayHwnd, -8, host.ToInt32());
            if (GetWindow(_overlayHwnd, 4) != host)
            {
                Console.Error.WriteLine("owner-attach-failed error=" + Marshal.GetLastWin32Error());
                return false;
            }
            Console.Error.WriteLine("owner-attached host=" + host.ToInt64() + " overlay=" + _overlayHwnd.ToInt64());
        }
        const int WS_EX_TOPMOST = 0x08;
        if ((GetWindowLong(_overlayHwnd, -20) & WS_EX_TOPMOST) != 0)
            if (!SetWindowPos(_overlayHwnd, (IntPtr)(-2) /* HWND_NOTOPMOST */, 0, 0, 0, 0, SWP_KEEP_GEOMETRY_AND_FOCUS | SWP_NOOWNERZORDER)) return false;
        IntPtr above = GetWindow(host, 3 /* GW_HWNDPREV */);
        if (above == _overlayHwnd) return true;
        // HWND_TOP keeps a non-topmost window below the topmost band.
        if (above != IntPtr.Zero && (GetWindowLong(above, -20) & WS_EX_TOPMOST) != 0) above = IntPtr.Zero;
        return SetWindowPos(_overlayHwnd, above, 0, 0, 0, 0, SWP_KEEP_GEOMETRY_AND_FOCUS | SWP_NOOWNERZORDER);
    }

    static IntPtr _overlayHwnd = IntPtr.Zero;
    static HashSet<int> _targetPids = new HashSet<int>();
    static HashSet<int> _overlayPids = new HashSet<int>();
    static IntPtr _targetHwnd = IntPtr.Zero;
    static int _targetPid = 0;
    static double _targetPidStart = 0;
    static int _lastReplayTick = 0;

    static double ProcessStartMs(int pid)
    {
        try
        {
            using (Process p = Process.GetProcessById(pid))
            {
                DateTime t = p.StartTime.ToUniversalTime();
                DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
                return (t - epoch).TotalMilliseconds;
            }
        }
        catch (Exception) { return 0; }
    }

    // Resident stdin command channel (one command per line):
    //   replay-click  re-inject a left click at the current cursor position, so
    //                 a click that dismissed our UI still reaches ZCode.
    //   handback      give the OS foreground back to the ZCode window.
    //   toolwindow    re-assert WS_EX_TOOLWINDOW on the overlay (setFocusable
    //                 rewrites the extended style and can drop it).
    static void CommandReader()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line == "replay-click") ReplayClick();
                else if (line == "handback") HandForegroundBack();
                else if (line == "toolwindow") EnsureToolWindow();
            }
        }
        catch (Exception) { }
    }

    static void ReplayClick()
    {
        int now = Environment.TickCount;
        if (now - _lastReplayTick < 300) return;
        _lastReplayTick = now;
        try
        {
            Thread.Sleep(50);
            mouse_event(0x02, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(30);
            mouse_event(0x04, 0, 0, 0, UIntPtr.Zero);
        }
        catch (Exception) { }
    }

    static void HandForegroundBack()
    {
        try
        {
            if (_targetHwnd == IntPtr.Zero || !IsWindow(_targetHwnd)) return;
            for (int i = 0; i < 4; i++)
            {
                IntPtr fg = GetForegroundWindow();
                uint fgThread = 0;
                uint pidDummy = 0;
                if (fg != IntPtr.Zero) fgThread = GetWindowThreadProcessId(fg, out pidDummy);
                uint me = GetCurrentThreadId();
                bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
                bool ok = SetForegroundWindow(_targetHwnd);
                if (attached) AttachThreadInput(me, fgThread, false);
                if (ok && GetForegroundWindow() == _targetHwnd) return;
                Thread.Sleep(70);
            }
        }
        catch (Exception) { }
    }

    static void EnsureToolWindow()
    {
        try
        {
            if (_overlayHwnd == IntPtr.Zero || !IsWindow(_overlayHwnd)) return;
            const int GWL_EXSTYLE = -20;
            const int WS_EX_TOOLWINDOW = 0x80;
            int ex = GetWindowLong(_overlayHwnd, GWL_EXSTYLE);
            if ((ex & WS_EX_TOOLWINDOW) == 0)
                SetWindowLong(_overlayHwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW);
        }
        catch (Exception) { }
    }

    // Largest visible top-level window among the target pids: ZCode keeps a
    // small always-alive window besides the real UI and .NET MainWindowHandle
    // may report that one instead.
    static IntPtr PickLargestWindow(HashSet<int> pids)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = -1;
        try
        {
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                uint p = 0;
                GetWindowThreadProcessId(h, out p);
                if (!pids.Contains((int)p)) return true;
                if (!IsWindowVisible(h)) return true;
                RECT r;
                if (!GetWindowRect(h, out r)) return true;
                if (IsIconic(h))
                {
                    WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
                    placement.Length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                    if (GetWindowPlacement(h, ref placement)) r = placement.NormalPosition;
                }
                long w = r.Right - r.Left;
                long hgt = r.Bottom - r.Top;
                if (w <= 0 || hgt <= 0) return true;
                long area = w * hgt;
                if (area > bestArea) { bestArea = area; best = h; }
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception) { }
        return best;
    }

    static void UpdateCache(string targetName, int overlayPid)
    {
        HashSet<int> tids = new HashSet<int>();
        try
        {
            Process[] procs = Process.GetProcessesByName(targetName);
            foreach (Process p in procs) { tids.Add(p.Id); p.Dispose(); }
        }
        catch (Exception) { }
        _targetPids = tids;

        IntPtr picked = PickLargestWindow(tids);
        bool keepMinimized = _targetHwnd != IntPtr.Zero && IsWindow(_targetHwnd) && (IsIconic(_targetHwnd) || !IsWindowVisible(_targetHwnd));
        if (!keepMinimized && (picked != IntPtr.Zero || _targetHwnd == IntPtr.Zero || !IsWindow(_targetHwnd))) _targetHwnd = picked;

        int ownerPid = 0;
        if (_targetHwnd != IntPtr.Zero)
        {
            uint op = 0;
            GetWindowThreadProcessId(_targetHwnd, out op);
            ownerPid = (int)op;
        }
        if (ownerPid > 0)
        {
            if (ownerPid != _targetPid) { _targetPid = ownerPid; _targetPidStart = ProcessStartMs(ownerPid); }
            else if (_targetPidStart == 0) { _targetPidStart = ProcessStartMs(ownerPid); }
        }

        HashSet<int> oids = new HashSet<int>();
        if (overlayPid > 0) oids.Add(overlayPid);
        _overlayPids = oids;
    }

    public static void Run(IntPtr overlay, int intervalMs, int cacheMs, string targetName, int overlayPid)
    {
        try
        {
            if (SetProcessDpiAwarenessContext((IntPtr)(-4)) == IntPtr.Zero) SetProcessDPIAware();
        }
        catch { SetProcessDPIAware(); }

        _overlayHwnd = overlay;
        Console.Error.WriteLine(
            "follow-start overlay=" + overlay.ToInt64() + " valid=" + IsWindow(overlay) +
            " interval=" + intervalMs + " cache=" + cacheMs + " target=" + targetName +
            " overlay-pid=" + overlayPid);

        UpdateCache(targetName, overlayPid);

        try
        {
            Thread reader = new Thread(CommandReader);
            reader.IsBackground = true;
            reader.Start();
        }
        catch (Exception) { }

        int lastCache = Environment.TickCount;
        int missSince = 0;
        bool haveSig = false;
        int lastL = 0, lastT = 0, lastW = 0, lastH = 0, lastPid = 0;
        bool lastShow = false;
        bool lastMin = false;

        while (true)
        {
            if (!IsWindow(overlay)) return;

            int now = Environment.TickCount;
            if (now - lastCache >= cacheMs) { UpdateCache(targetName, overlayPid); lastCache = now; }

            IntPtr z = (_targetHwnd != IntPtr.Zero && IsWindow(_targetHwnd)) ? _targetHwnd : IntPtr.Zero;
            if (z == IntPtr.Zero)
            {
                haveSig = false;
                if (missSince == 0)
                {
                    missSince = now;
                    Console.Out.WriteLine("{\"hide\":true}");
                    Console.Out.Flush();
                }
                else if (now - missSince >= 5000 && _targetPids.Count == 0)
                {
                    Console.Out.WriteLine("{\"gone\":true}");
                    Console.Out.Flush();
                    return;
                }
                Thread.Sleep(intervalMs);
                continue;
            }
            missSince = 0;

            // Client area in physical pixels: the overlay window is sized to
            // exactly this rect so the page viewport matches the ZCode chat area.
            RECT c;
            POINT origin = new POINT();
            bool haveRect = false;
            int left = 0, top = 0, width = 0, height = 0;
            if (GetClientRect(z, out c) && ClientToScreen(z, ref origin))
            {
                left = origin.X;
                top = origin.Y;
                width = c.Right - c.Left;
                height = c.Bottom - c.Top;
                haveRect = width > 0 && height > 0;
            }

            if (haveRect)
            {
                bool minimized = IsIconic(z);
                bool visible = IsWindowVisible(z);
                int cloaked = 0;
                bool isCloaked = DwmGetWindowAttribute(z, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0;

                uint fgPid = 0;
                IntPtr fg = GetForegroundWindow();
                if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fgPid);
                bool fgIsTarget = _targetPids.Contains((int)fgPid);
                bool fgIsOverlay = _overlayPids.Contains((int)fgPid);
                // Foreground ownership is diagnostic only; focus changes must not hide the widget.
                bool show = !minimized && visible && !isCloaked;
                if (show) SyncOverlayOrder(z);

                if (!haveSig || left != lastL || top != lastT || width != lastW || height != lastH
                    || show != lastShow || minimized != lastMin || _targetPid != lastPid)
                {
                    haveSig = true;
                    lastL = left; lastT = top; lastW = width; lastH = height;
                    lastShow = show; lastMin = minimized; lastPid = _targetPid;

                    Console.Error.WriteLine(
                        "state show=" + (show ? "true" : "false") +
                        " minimized=" + (minimized ? "true" : "false") +
                        " visible=" + (visible ? "true" : "false") +
                        " cloaked=" + (isCloaked ? "true" : "false") +
                        " fgPid=" + fgPid +
                        " fgIsTarget=" + (fgIsTarget ? "true" : "false") +
                        " fgIsOverlay=" + (fgIsOverlay ? "true" : "false") +
                        " pid=" + _targetPid);

                    Console.Out.WriteLine(
                        "{\"x\":" + left + ",\"y\":" + top + ",\"w\":" + width + ",\"h\":" + height +
                        ",\"show\":" + (show ? "true" : "false") +
                        ",\"minimized\":" + (minimized ? "true" : "false") +
                        ",\"pid\":" + _targetPid + ",\"pidStart\":" + ((long)_targetPidStart) +
                        ",\"hostHwnd\":" + z.ToInt64() + ",\"overlayHwnd\":" + _overlayHwnd.ToInt64() + "}");
                    Console.Out.Flush();
                }
            }

            Thread.Sleep(intervalMs);
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine('csharp-compile-failed: ' + $_.Exception.Message)
  exit 1
}

try {
  [WhaleFollow]::Run([IntPtr][long]$OverlayHwnd, $IntervalMs, $ProcessCacheMs, $targetProcess, $OverlayPid)
} catch {
  [Console]::Error.WriteLine('follow-loop-error: ' + $_.Exception.Message)
  exit 1
}
