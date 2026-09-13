param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
# Repair only this app's legacy installer location, never application data,
# credentials, security policy, or an uninstall command. Dry-run by default.
$taskRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InstallRoot).Path).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'An absolute installation root is required.' }
foreach ($name in @('DeepSeek Harness Desktop.exe', 'Uninstall DeepSeek Harness Desktop.exe', 'resources\app.asar')) {
  if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $name) -PathType Leaf)) { throw "Selected installation is incomplete: $name" }
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LegacyInstallPaths {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathName(string path, StringBuilder result, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetLongPathName(string path, StringBuilder result, uint size);
}
'@
function Expand-LegacyPath([string]$Value) {
  $buffer = [Text.StringBuilder]::new(32768)
  $length = [LegacyInstallPaths]::GetLongPathName($Value, $buffer, 32768)
  if ($length -eq 0 -or $length -ge 32768) { throw 'Cannot verify the existing installation path.' }
  return [IO.Path]::GetFullPath($buffer.ToString()).TrimEnd('\')
}
$buffer = [Text.StringBuilder]::new(32768)
$length = [LegacyInstallPaths]::GetShortPathName($taskRoot, $buffer, 32768)
if ($length -eq 0 -or $length -ge 32768) { throw 'This installation has no usable existing short path.' }
$shortRoot = $buffer.ToString()
if (-not [string]::Equals((Expand-LegacyPath $shortRoot), (Expand-LegacyPath $taskRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'Short path does not identify the selected installation.' }
if ($shortRoot.Length -ge $taskRoot.Length) { throw 'The existing alias does not shorten this installation path.' }
$guid = '9014936e-a931-55bf-822f-daf6f86139e2'
$keys = @("Software\$guid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
$changes = @()
foreach ($viewName in @('Registry32', 'Registry64')) {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::$viewName)
  try {
    foreach ($subKey in $keys) {
      $key = $baseKey.OpenSubKey($subKey, $false)
      try {
        if ($null -eq $key) { continue }
        $value = $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $value) { continue }
        if ($key.GetValueKind('InstallLocation') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'Unexpected registry value type.' }
        if (-not [string]::Equals((Expand-LegacyPath $value), (Expand-LegacyPath $taskRoot), [StringComparison]::OrdinalIgnoreCase)) { throw "Another installation owns $subKey; no changes made." }
        $changes += [pscustomobject]@{ view=$viewName; key=$subKey; name='InstallLocation'; before=[string]$value; after=$shortRoot }
      } finally { if ($null -ne $key) { $key.Dispose() } }
    }
  } finally { $baseKey.Dispose() }
}
if ($changes.Count -eq 0) { throw 'No registered installation matched the selected directory.' }
$report = [ordered]@{ installRoot=$taskRoot; shortRoot=$shortRoot; applied=$false; changes=$changes }
if ($Apply) {
  $backupDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.test-data\legacy-install-repair'
  [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
  $backup = Join-Path $backupDirectory ('registry-before-' + [Guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($backup, ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  foreach ($change in $changes) {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::$($change.view))
    try {
      $key = $baseKey.OpenSubKey($change.key, $true)
      try {
        $current = $key.GetValue($change.name)
        # The two registry views may share the same physical value.
        if ($current -ne $change.before -and $current -ne $change.after) { throw 'Installer registration changed concurrently; backup preserved.' }
        $key.SetValue($change.name, $change.after, [Microsoft.Win32.RegistryValueKind]::String)
        $key.Flush()
      } finally { $key.Dispose() }
    } finally { $baseKey.Dispose() }
  }
  $report.applied = $true
  $report.backup = $backup
}
$report | ConvertTo-Json -Depth 5
