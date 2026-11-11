/** Native Windows implementations behind the existing injected OS runner.
 * Fixed PowerShell data is written to a private temp file; user data travels as JSON.
 * No commands, paths or captions are interpolated into executable source.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RunOptions, RunResult, Runner } from "./types.ts";

export const WINDOWS_SCRIPT = String.raw`param([string]$JobFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$j = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
function Offline([string]$p) { return (([int][IO.File]::GetAttributes($p) -band 0x441000) -ne 0) }
function Open-Photo([string]$p) {
  if (Offline $p) { throw 'offline' }
  $ms = [IO.MemoryStream]::new([IO.File]::ReadAllBytes($p), $false)
  $orientation = 1
  try { $im = [Drawing.Image]::FromStream($ms, $true, $true) }
  catch {
    $ms.Dispose()
    Add-Type -AssemblyName PresentationCore
    $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create([Uri]$p, [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
    $frame = $decoder.Frames[0]
    foreach ($q in @('/app1/ifd/{ushort=274}', '/ifd/{ushort=274}')) {
      try { $v = $frame.Metadata.GetQuery($q); if ($v) { $orientation = [int]$v; break } } catch {}
    }
    $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($frame))
    $ms = New-Object IO.MemoryStream
    $enc.Save($ms); $ms.Position = 0
    $im = [Drawing.Image]::FromStream($ms, $true, $true)
  }
  if ($im.PropertyIdList -contains 274) { $orientation = [BitConverter]::ToUInt16($im.GetPropertyItem(274).Value, 0) }
  return @{ image = $im; stream = $ms; orientation = $orientation }
}
try {
  switch ($j.operation) {
    'folders' {
      $r = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
      $out = @{}
      foreach ($pair in @(@('Downloads','{374DE290-123F-4565-9164-39C4925E467B}'),@('Desktop','Desktop'),@('Pictures','My Pictures'),@('Movies','My Video'))) {
        $v = $r.($pair[1]); if ($v) { $out[$pair[0]] = [Environment]::ExpandEnvironmentVariables($v) }
      }
      ConvertTo-Json -InputObject $out -Compress
    }
    'attributes' {
      $out = @($j.paths | ForEach-Object { try { @{ path = $_; offline = (Offline $_) } } catch { @{ path = $_; offline = $true } } })
      ConvertTo-Json -InputObject $out -Compress
    }
    'selection' {
      $out = @(); $shell = New-Object -ComObject Shell.Application
      foreach ($w in @($shell.Windows())) {
        try { if ([IO.Path]::GetFileName($w.FullName) -ieq 'explorer.exe') { foreach ($item in @($w.Document.SelectedItems())) { if ($out.Count -lt 20) { $out += [string]$item.Path } } } } catch {}
      }
      [Console]::Write(($out -join [char]10))
    }
    'clipboard' { Set-Clipboard -Value ([string]$j.text) }
    default {
      Add-Type -AssemblyName System.Drawing
      $out = @()
      foreach ($job in @($j.jobs)) {
        $photo = $null; $bmp = $null; $g = $null
        try {
          $photo = Open-Photo $job.source; $im = $photo.image
          if ($j.operation -eq 'probe') {
            $fmt = [IO.Path]::GetExtension($job.source).TrimStart('.').ToLowerInvariant(); if ($fmt -eq 'jpg') { $fmt = 'jpeg' }
            $out += @{ path = $job.source; width = $im.Width; height = $im.Height; format = $fmt; alpha = ([Drawing.Image]::IsAlphaPixelFormat($im.PixelFormat) -or (($im.Flags -band 2) -ne 0)) }
            continue
          }
          $flips = @('RotateNoneFlipNone','RotateNoneFlipNone','RotateNoneFlipX','Rotate180FlipNone','Rotate180FlipX','Rotate90FlipX','Rotate90FlipNone','Rotate270FlipX','Rotate270FlipNone')
          $o = [Math]::Max(1, [Math]::Min(8, [int]$photo.orientation)); $im.RotateFlip([Enum]::Parse([Drawing.RotateFlipType], $flips[$o]))
          $iw = $im.Width; $ih = $im.Height; $w = $iw; $h = $ih; $x = 0.0; $y = 0.0; $dw = [double]$iw; $dh = [double]$ih
          switch ($job.mode) {
            'fit' { $s = [Math]::Min(1, [Math]::Min(1920.0 / [Math]::Max($iw,$ih),1080.0 / [Math]::Min($iw,$ih))); $w = [int][Math]::Round($iw*$s); $h = [int][Math]::Round($ih*$s); $dw=$w; $dh=$h }
            'crop' { $w=[int]$job.width; $h=[int]$job.height; $s=[Math]::Max($w/[double]$iw,$h/[double]$ih); $dw=$iw*$s; $dh=$ih*$s; $x=($w-$dw)/2; $y=($h-$dh)/2 }
            'stretch' { $w=[int]$job.width; $h=[int]$job.height; $dw=$w; $dh=$h }
            'resize' { if ($iw -gt [int]$job.width) { $w=[int]$job.width; $h=[int][Math]::Round($ih*$w/[double]$iw); $dw=$w; $dh=$h } }
          }
          if ($w -lt 1 -or $h -lt 1 -or $w -gt 32768 -or $h -gt 32768) { throw 'dimensions' }
          $bmp = [Drawing.Bitmap]::new($w,$h,[Drawing.Imaging.PixelFormat]::Format24bppRgb)
          $g = [Drawing.Graphics]::FromImage($bmp); $g.Clear([Drawing.Color]::White)
          $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.DrawImage($im, [Drawing.RectangleF]::new([single]$x,[single]$y,[single]$dw,[single]$dh))
          if ($job.format -eq 'bmp') { $bmp.Save([string]$job.dest,[Drawing.Imaging.ImageFormat]::Bmp) }
          else {
            $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg' | Select-Object -First 1
            $ep = [Drawing.Imaging.EncoderParameters]::new(1)
            try { $ep.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality,[long]$job.quality); $bmp.Save([string]$job.dest,$codec,$ep) } finally { $ep.Dispose() }
          }
          $out += @{ path = $job.dest; width = $w; height = $h }
        } catch { $out += @{ path = $job.source; failed = $true } }
        finally { if ($g) { $g.Dispose() }; if ($bmp) { $bmp.Dispose() }; if ($photo) { $photo.image.Dispose(); $photo.stream.Dispose() } }
      }
      ConvertTo-Json -InputObject $out -Compress
    }
  }
} catch { [Console]::Error.WriteLine('Windows operation failed'); exit 1 }
`;

const empty = (code = 0, stdout = ""): RunResult => ({ code, stdout, stderr: "", timedOut: false });

export async function windowsOperation(base: Runner, job: Record<string, unknown>, opts: RunOptions = {}): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-windows-"));
  try {
    const script = join(dir, "native.ps1"), data = join(dir, "job.json");
    writeFileSync(script, "\ufeff" + WINDOWS_SCRIPT, { mode: 0o600 });
    writeFileSync(data, JSON.stringify(job), { mode: 0o600 });
    return await base(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "-JobFile", data], opts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const nativeRunners = new WeakSet<Runner>();
export const isWindowsRunner = (runner: Runner): boolean => nativeRunners.has(runner);

/** Converts our small OS command protocol to native Windows operations. Other binaries run unchanged. */
export function windowsRunner(base: Runner): Runner {
  const runner: Runner = async (cmd, opts = {}) => {
    const name = basename(cmd[0]).toLowerCase();
    if (name === "voiceos-windows") return windowsOperation(base, { operation: cmd[1], paths: cmd.slice(2) }, opts);
    if (name === "pbcopy") return windowsOperation(base, { operation: "clipboard", text: opts.stdin ?? "" }, opts);
    if (name === "mdls" || name === "xattr" || name === "qlmanage") return empty(127);
    if (name === "defaults") return empty(0, join(process.env.USERPROFILE ?? "", "Pictures", "Screenshots"));
    if (name === "open" && cmd[1] === "-R") return base(["explorer.exe", `/select,${cmd[2]}`], opts);
    if (name === "osascript") {
      if (cmd.includes("JavaScript")) {
        const paths = cmd.slice(cmd.indexOf("-e") + 2);
        return empty(0, JSON.stringify(paths.map(p => { try { return statSync(p).birthtimeMs || null; } catch { return null; } })));
      }
      if (cmd.some(s => s.includes('tell application "Finder"'))) return windowsOperation(base, { operation: "selection" }, opts);
      return empty(0, "NOT_RUNNING"); // QuickTime is a macOS-only source.
    }
    if (name !== "sips") return base(cmd, opts);
    const args = cmd.slice(1), inputs: string[] = [], props: string[] = [];
    let dest = "", script = "", width = 0, height = 0, quality = 85, format = "jpeg";
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-g") props.push(args[++i]);
      else if (a === "-j") script = args[++i];
      else if (a === "-o" || a === "--out") dest = args[++i];
      else if (a === "--matchTo") i++;
      else if (a === "-s") { const k = args[++i], v = args[++i]; if (k === "formatOptions") quality = Number(v); if (k === "format") format = v; }
      else if (a === "--resampleWidth") width = Number(args[++i]);
      else if (a === "-z") { height = Number(args[++i]); width = Number(args[++i]); }
      else if (a.startsWith("-")) return empty(127);
      else inputs.push(a);
    }
    if (props.length) {
      const r = await windowsOperation(base, { operation: "probe", jobs: inputs.map(source => ({ source })) }, opts);
      if (r.code || r.timedOut) return r;
      try {
        const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
        return { ...r, stdout: rows.map(x => `${x.path}:\n  pixelWidth: ${x.width ?? 0}\n  pixelHeight: ${x.height ?? 0}\n  format: ${x.format ?? ""}\n  hasAlpha: ${x.alpha ? "yes" : "no"}`).join("\n") };
      } catch { return empty(1); }
    }
    let mode = height ? "stretch" : width ? "resize" : "copy";
    if (script) {
      const text = readFileSync(script, "utf8");
      if (text.startsWith("// sips-orient.js:")) mode = "fit";
      else { const m = /^\/\/ tiktok thumbs: orient, centre-crop to (\d+)x(\d+),/.exec(text); if (!m) return empty(127); mode = "crop"; width = Number(m[1]); height = Number(m[2]); }
    }
    const isDir = (() => { try { return statSync(dest).isDirectory(); } catch { return false; } })();
    const jobs = inputs.map((source, i) => ({ source, dest: script ? join(dest, mode === "fit" ? `${i}.oriented.jpg` : `${i}.jpg`) : isDir ? join(dest, basename(source)) : dest, mode, width, height, quality, format }));
    return windowsOperation(base, { operation: "convert", jobs }, opts);
  };
  nativeRunners.add(runner);
  return runner;
}
