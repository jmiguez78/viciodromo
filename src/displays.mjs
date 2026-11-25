// Monitor de cada juego. Cada juego puede tener su monitor predeterminado (se elige desde Jugar ▾ o en Editar); al
// jugar también se puede elegir otro sólo por esa vez. Sin elección no se hace nada: Windows lo abre donde siempre
// (el monitor principal).
// Electron informa los monitores (nombre, rectángulo y su equivalente en píxeles físicos). En Windows, un ayudante de
// PowerShell busca la ventana del juego (un proceso que corre desde su carpeta) y la lleva al monitor elegido; a
// MAME, en cambio, se le indica la pantalla al abrirlo (-screen), porque su pantalla completa no se deja mover.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const WAIT_SECONDS = 240; // lo que puede tardar un lanzador (Epic, Ubisoft, EA) en abrir el juego
const SETTLE_SECONDS = 30; // después de mover la primera ventana, se siguen mirando las que aparezcan (splash → juego)

const rect = (value) =>
  value && ['x', 'y', 'width', 'height'].every((name) => Number.isFinite(value[name]))
    ? {
        x: Math.round(value.x),
        y: Math.round(value.y),
        width: Math.round(value.width),
        height: Math.round(value.height)
      }
    : null;

// Monitores como los informa Electron, ordenados de izquierda a derecha. `name` es el nombre del monitor (por ejemplo
// «LG TV SSCR2»); sin nombre, o con dos iguales, se numeran.
export function describeDisplays(raw = []) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((item) => item && item.id !== undefined && rect(item.bounds))
    .map((item) => ({
      id: String(item.id),
      label: typeof item.label === 'string' ? item.label.trim().slice(0, 120) : '',
      primary: item.primary === true,
      bounds: rect(item.bounds),
      physical: rect(item.physical)
    }))
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const count = new Map();
  for (const item of list) count.set(item.label, (count.get(item.label) ?? 0) + 1);
  const seen = new Map();
  return list.map((item, index) => {
    const repeated = count.get(item.label) > 1;
    const order = (seen.get(item.label) ?? 0) + 1;
    seen.set(item.label, order);
    const name = !item.label ? `Monitor ${index + 1}` : repeated ? `${item.label} (${order})` : item.label;
    return { ...item, name };
  });
}

// Lo que se guarda de un monitor: su identificador y su nombre (si el identificador cambia, se lo reconoce por nombre).
export function cleanDisplayRef(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.trim().slice(0, 64) : '';
  const label = typeof value.label === 'string' ? value.label.trim().slice(0, 120) : '';
  return id || label ? { id, label } : null;
}

export const displayRef = (display) => ({ id: display.id, label: display.label || display.name });

export function findDisplay(list, ref) {
  const clean = cleanDisplayRef(ref);
  if (!clean) return null;
  return (
    (clean.id && list.find((item) => item.id === clean.id)) ||
    (clean.label && list.find((item) => item.label === clean.label || item.name === clean.label)) ||
    null
  );
}

// A qué monitor va un juego: { display, source: 'once' | 'game' } o null (se deja a Windows). `once` es el elegido
// sólo para esta vez; si no está conectado, se usa el predeterminado del juego, y si tampoco, ninguno.
export function chooseDisplay(game, list, once = null) {
  if (!list?.length) return null;
  const chosen = once && findDisplay(list, once);
  if (chosen) return { display: chosen, source: 'once' };
  const display = game?.display && findDisplay(list, game.display);
  return display ? { display, source: 'game' } : null;
}

export function describeChoice(choice) {
  if (!choice) return 'monitor principal';
  return choice.source === 'once' ? `${choice.display.name} (sólo esta vez)` : choice.display.name;
}

// El monitor de Windows (\\.\DISPLAYn) que contiene el centro del monitor de Electron, en píxeles físicos.
export function deviceFor(monitors, display) {
  const area = display?.physical ?? display?.bounds;
  if (!area || !Array.isArray(monitors)) return null;
  const x = area.x + area.width / 2;
  const y = area.y + area.height / 2;
  const found = monitors.find(
    (item) => x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height
  );
  return typeof found?.device === 'string' && /^\\\\\.\\DISPLAY\d+$/i.test(found.device) ? found.device : null;
}

// Argumentos del ayudante para mover las ventanas de las carpetas `roots` al monitor `display`.
export function placeArgs(script, roots, display, { wait = WAIT_SECONDS, settle = SETTLE_SECONDS } = {}) {
  const area = display.physical ?? display.bounds;
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Mode',
    'place',
    '-Roots',
    roots.join('|'),
    '-Target',
    [area.x, area.y, area.width, area.height].join(','),
    '-Wait',
    String(wait),
    '-Settle',
    String(settle)
  ];
}

// Ayudante de Windows: lista los monitores (en píxeles físicos) o busca las ventanas de un juego y las mueve.
// Una ventana normal conserva su lugar relativo; una maximizada se vuelve a maximizar en el otro monitor; una que
// ocupa todo el monitor (pantalla completa sin bordes) pasa a ocupar el otro. Cada ventana se reubica a lo sumo tres
// veces, por si el juego la devuelve al principal al terminar de cargar.
export const HELPER_SCRIPT = String.raw`param(
  [string]$Mode = 'monitors',
  [string]$Roots = '',
  [string]$Target = '',
  [int]$Wait = 240,
  [int]$Settle = 30
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ViciodromoDisplays {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  public class Monitor { public string Device; public RECT Rect; }
  delegate bool MonitorProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
  delegate bool WindowProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowProc proc, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  static Monitor Info(IntPtr handle) {
    MONITORINFOEX info = new MONITORINFOEX();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
    if (!GetMonitorInfo(handle, ref info)) return null;
    Monitor monitor = new Monitor(); monitor.Device = info.szDevice; monitor.Rect = info.rcMonitor;
    return monitor;
  }
  public static List<Monitor> Monitors() {
    List<Monitor> list = new List<Monitor>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr handle, IntPtr hdc, ref RECT rect, IntPtr data) {
      Monitor monitor = Info(handle); if (monitor != null) list.Add(monitor); return true;
    }, IntPtr.Zero);
    return list;
  }
  public static Monitor At(int x, int y) {
    foreach (Monitor monitor in Monitors())
      if (x >= monitor.Rect.Left && x < monitor.Rect.Right && y >= monitor.Rect.Top && y < monitor.Rect.Bottom) return monitor;
    return null;
  }
  static string ProcessPath(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return null;
    try {
      StringBuilder name = new StringBuilder(1024); int size = name.Capacity;
      return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString(0, size) : null;
    } finally { CloseHandle(process); }
  }
  // Ventanas principales visibles de procesos que corren desde alguna de las carpetas.
  public static List<IntPtr> Windows(string[] roots) {
    List<IntPtr> found = new List<IntPtr>();
    Dictionary<uint, bool> owned = new Dictionary<uint, bool>();
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      if (!IsWindowVisible(window) || IsIconic(window) || GetWindow(window, 4) != IntPtr.Zero) return true;
      if ((GetWindowLong(window, -20) & 0x80) != 0) return true;
      RECT rect; GetWindowRect(window, out rect);
      if (rect.Right - rect.Left < 160 || rect.Bottom - rect.Top < 120) return true;
      uint pid; GetWindowThreadProcessId(window, out pid);
      bool match;
      if (!owned.TryGetValue(pid, out match)) {
        string file = ProcessPath(pid);
        match = false;
        if (file != null) {
          string lower = file.ToLowerInvariant();
          foreach (string root in roots) if (root.Length > 0 && lower.StartsWith(root)) { match = true; break; }
        }
        owned[pid] = match;
      }
      if (match) found.Add(window);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool OnMonitor(IntPtr window, RECT target) {
    Monitor current = Info(MonitorFromWindow(window, 2));
    return current != null && current.Rect.Left == target.Left && current.Rect.Top == target.Top && current.Rect.Right == target.Right && current.Rect.Bottom == target.Bottom;
  }
  public static string Place(IntPtr window, RECT target) {
    const uint NOSIZE = 0x1, NOZORDER = 0x4, NOACTIVATE = 0x10;
    Monitor current = Info(MonitorFromWindow(window, 2));
    if (current == null) return "sin-monitor";
    if (OnMonitor(window, target)) return "ya-estaba";
    RECT from = current.Rect; RECT rect; GetWindowRect(window, out rect);
    int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
    int targetWidth = target.Right - target.Left, targetHeight = target.Bottom - target.Top;
    if (rect.Left <= from.Left && rect.Top <= from.Top && rect.Right >= from.Right && rect.Bottom >= from.Bottom) {
      SetWindowPos(window, IntPtr.Zero, target.Left, target.Top, targetWidth, targetHeight, NOZORDER | NOACTIVATE);
      return "pantalla-completa";
    }
    if (IsZoomed(window)) {
      ShowWindow(window, 9);
      GetWindowRect(window, out rect);
      width = rect.Right - rect.Left; height = rect.Bottom - rect.Top;
      SetWindowPos(window, IntPtr.Zero, target.Left + Math.Max(0, (targetWidth - width) / 2), target.Top + Math.Max(0, (targetHeight - height) / 2), 0, 0, NOSIZE | NOZORDER | NOACTIVATE);
      ShowWindow(window, 3);
      return "maximizada";
    }
    int x = target.Left + Math.Max(0, Math.Min(rect.Left - from.Left, targetWidth - width));
    int y = target.Top + Math.Max(0, Math.Min(rect.Top - from.Top, targetHeight - height));
    SetWindowPos(window, IntPtr.Zero, x, y, 0, 0, NOSIZE | NOZORDER | NOACTIVATE);
    return "ventana";
  }
}
'@
[ViciodromoDisplays]::DpiAware()
if ($Mode -eq 'monitors') {
  $list = @([ViciodromoDisplays]::Monitors() | ForEach-Object {
    [pscustomobject]@{ device = $_.Device; x = $_.Rect.Left; y = $_.Rect.Top; width = $_.Rect.Right - $_.Rect.Left; height = $_.Rect.Bottom - $_.Rect.Top }
  })
  ConvertTo-Json -InputObject $list -Compress
  exit 0
}
$area = @($Target.Split(',') | ForEach-Object { [int]$_ })
$monitor = [ViciodromoDisplays]::At($area[0] + [int]($area[2] / 2), $area[1] + [int]($area[3] / 2))
if ($null -eq $monitor) { Write-Output 'sin-monitor'; exit 2 }
$folders = [string[]]@($Roots.Split('|') | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
$moves = @{}
$start = Get-Date
$first = $null
while ($true) {
  $now = Get-Date
  if ($first) { if (($now - $first).TotalSeconds -gt $Settle) { break } }
  elseif (($now - $start).TotalSeconds -gt $Wait) { Write-Output 'sin-ventana'; exit 3 }
  foreach ($window in [ViciodromoDisplays]::Windows($folders)) {
    $key = [string]$window
    $count = [int]$moves[$key]
    if ($count -ge 3 -or [ViciodromoDisplays]::OnMonitor($window, $monitor.Rect)) {
      if (-not $first) { $first = Get-Date }
      continue
    }
    $result = [ViciodromoDisplays]::Place($window, $monitor.Rect)
    $moves[$key] = $count + 1
    Write-Output $result
    if (-not $first) { $first = Get-Date }
  }
  Start-Sleep -Milliseconds 500
}
exit 0
`;

// El ayudante se escribe una vez por versión del script en la carpeta temporal y se ejecuta con -File.
export function createDisplayHelper({
  platform = process.platform,
  execFileImpl = execFile,
  spawnImpl = spawn,
  tempDir = os.tmpdir(),
  log = () => {}
} = {}) {
  let scriptPath = null;
  let cached = { at: 0, monitors: null };
  async function script() {
    if (scriptPath) return scriptPath;
    const hash = crypto.createHash('sha256').update(HELPER_SCRIPT).digest('hex').slice(0, 12);
    const file = path.join(tempDir, `viciodromo-monitores-${hash}.ps1`);
    // BOM: PowerShell 5 lee un .ps1 sin BOM como ANSI.
    await fs.writeFile(file, '﻿' + HELPER_SCRIPT, 'utf8');
    scriptPath = file;
    return file;
  }
  return {
    supported: platform === 'win32',
    // Monitores de Windows con su nombre de dispositivo (\\.\DISPLAYn), en píxeles físicos. Se recuerdan 30 s.
    async monitors() {
      if (platform !== 'win32') return [];
      if (cached.monitors && Date.now() - cached.at < 30000) return cached.monitors;
      const file = await script();
      const monitors = await new Promise((resolve) => {
        execFileImpl(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Mode', 'monitors'],
          { windowsHide: true, timeout: 20000 },
          (error, stdout) => {
            if (error) return resolve(null);
            try {
              const parsed = JSON.parse(String(stdout).trim());
              resolve(Array.isArray(parsed) ? parsed : [parsed]);
            } catch {
              resolve(null);
            }
          }
        );
      });
      if (monitors) cached = { at: Date.now(), monitors };
      return monitors ?? [];
    },
    // Argumentos para que MAME abra en ese monitor (vacío si no se pudo averiguar).
    async mameArgs(display) {
      const device = deviceFor(await this.monitors(), display);
      return device ? ['-screen', device] : [];
    },
    // Busca las ventanas del juego y las lleva al monitor. No espera: el ayudante termina solo.
    async place(roots, display, label = '') {
      if (platform !== 'win32' || !roots.length) return false;
      const file = await script();
      const child = spawnImpl('powershell.exe', placeArgs(file, roots, display), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const output = [];
      child.stdout?.on('data', (chunk) => output.push(String(chunk)));
      child.stderr?.on('data', (chunk) => output.push(String(chunk)));
      child.once('error', (error) => log('warn', 'monitor', `${label}: no se pudo mover la ventana: ${error.message}`));
      child.once('exit', (code) => {
        const result = output.join('').split(/\r?\n/).filter(Boolean).slice(-4).join(', ') || 'sin salida';
        const level = code === 0 ? 'info' : 'warn';
        log(level, 'monitor', `${label} → ${display.name}: ${code === 3 ? 'no apareció la ventana' : result}`);
      });
      return true;
    }
  };
}
