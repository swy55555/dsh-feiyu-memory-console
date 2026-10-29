param(
  [ValidateSet('Start','RestartBridge','Check')][string]$Action='Start',
  [string]$ConfigPath=(Join-Path $env:USERPROFILE '.dsh\xinji-launcher.json'),
  [switch]$NoPause,
  [switch]$NoOpen
)
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bridgeRoot=[IO.Path]::GetFullPath($settings.bridgeRoot)
$entry=Join-Path $bridgeRoot 'src\bridge.js'
$loop=Join-Path $bridgeRoot 'bridge-loop.cmd'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$guardPattern=[regex]::Escape($loop)
function Read-EngineCheck {
  # Node emits UTF-8. Windows PowerShell's native pipeline may instead decode
  # with the console's GBK/OEM code page, corrupting JSON string boundaries.
  $info=New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName=$node
  $info.Arguments='"'+$entry+'" --check'
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true
  $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=New-Object System.Text.UTF8Encoding($false,$true)
  $info.StandardErrorEncoding=New-Object System.Text.UTF8Encoding($false,$true)
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$info
  try {
    if(!$process.Start()){throw '无法启动心迹入口检查。'}
    $stdout=$process.StandardOutput.ReadToEndAsync()
    $stderr=$process.StandardError.ReadToEndAsync()
    if(!$process.WaitForExit(15000)){$process.Kill();throw '心迹入口检查超时。'}
    $text=$stdout.GetAwaiter().GetResult()
    $errorText=$stderr.GetAwaiter().GetResult()
    if($process.ExitCode -ne 0){throw ('心迹入口检查失败：'+$errorText)}
    return ($text | ConvertFrom-Json)
  } finally {$process.Dispose()}
}
function Listener([int]$Port) {
  $connection=Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if($connection){Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"}
}
function Wait-Listener([int]$Port,[int]$Seconds) {
  for($i=0;$i -lt $Seconds;$i++){if(Listener $Port){return};Start-Sleep -Seconds 1}
  throw "端口 $Port 在 $Seconds 秒内未就绪，请查看服务日志。"
}
function Guardians {
  @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object {$_.CommandLine -match $guardPattern})
}
function Stop-Verified($Item) {
  if(!$Item){return}
  $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($Item.ProcessId)" -ErrorAction SilentlyContinue
  if($current -and $current.CreationDate -eq $Item.CreationDate -and $current.ExecutablePath -eq $Item.ExecutablePath){Stop-Process -Id $Item.ProcessId -Force}
}
function Start-Bridge {
  if(Listener 3100){return}
  if(@(Guardians).Count -eq 0){
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',('"'+$loop+'"')) -WorkingDirectory $bridgeRoot -WindowStyle Hidden
  }
  Wait-Listener 3100 60
}
$mutex=New-Object Threading.Mutex($false,('Local\XinjiLauncher-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$locked=$false
try {
  try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
  if(!$locked){throw '另一个心迹启动或重启操作正在进行，请稍后再试。'}
  if(!(Test-Path -LiteralPath $entry) -or !(Test-Path -LiteralPath $loop)){throw '心迹入口或守护脚本不存在。'}
  $report=Read-EngineCheck
  if(!$report.ok -or $report.engine -ne 'xinji'){throw '心迹运行时检查未通过。'}
  if($Action -eq 'Check'){
    [pscustomobject]@{engine=$report.engine;runtimeOk=$report.ok;dsh=[bool](Listener 3080);memory=[bool](Listener 9881);bridge=[bool](Listener 3100);guardians=@(Guardians).Count} | ConvertTo-Json
    return
  }
  if($Action -eq 'RestartBridge'){
    $bridge=Listener 3100;$guards=@(Guardians)
    if($guards.Count -gt 1){throw '发现多个桥接守护进程，请先核对，未自动结束。'}
    if($bridge){
      if($bridge.ExecutablePath -ne $node -or $bridge.CommandLine -notmatch '(^|[\s"\\/])bridge\.js([\s"]|$)' -or $bridge.ParentProcessId -notin @($guards | ForEach-Object ProcessId)){throw '端口 3100 不是由已核对的心迹守护进程启动，未结束该进程。'}
    }
    $children=@(Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -in @($guards | ForEach-Object ProcessId) -and $_.ExecutablePath -eq $node -and $_.CommandLine -match 'bridge\.js'})
    foreach($guard in $guards){Stop-Verified $guard}
    foreach($child in $children){Stop-Verified $child}
    if($bridge){Stop-Verified $bridge}
    Start-Sleep -Seconds 1
    if(Listener 3100){throw '旧桥接仍在运行，未启动重复实例。'}
    Start-Bridge
    Write-Host '心迹桥接已重启，DSH 和记忆服务保持运行。' -ForegroundColor Green
  } else {
    if(!(Get-Process -Name QQ -ErrorAction SilentlyContinue)){Start-Process -FilePath $settings.qqExe -WindowStyle Hidden}
    if(!(Listener 3001)){Start-Process -FilePath wscript.exe -ArgumentList ('"'+$settings.snowLauncher+'"') -WindowStyle Hidden;Wait-Listener 3001 30}
    if(!(Listener 9881)){
      $memoryProc=Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like ('*'+$settings.memoryScript+'*') -and $_.Name -match '^python'}
      if(!$memoryProc){Start-Process -FilePath $settings.pythonExe -ArgumentList ('"'+$settings.memoryScript+'"') -WorkingDirectory (Split-Path $settings.memoryScript) -WindowStyle Hidden}
      Wait-Listener 9881 40
    }
    if(!(Listener 3080)){
      $dshProc=Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq $settings.dshExe
      if(!$dshProc){Start-Process -FilePath $settings.dshExe -WorkingDirectory (Split-Path $settings.dshExe) -WindowStyle Hidden}
      Wait-Listener 3080 90
    }
    Start-Bridge
    Write-Host '心迹服务已就绪。已运行的服务不会重复启动。' -ForegroundColor Green
  }
  if(!$NoOpen){Start-Process 'http://127.0.0.1:3080/dsh-feiyu-memory/#/persona'}
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()
  if(!$NoPause -and $Action -ne 'Check'){Read-Host '按回车关闭此窗口' | Out-Null}
}
