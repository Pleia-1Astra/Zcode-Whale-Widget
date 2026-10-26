param(
  [Parameter(Mandatory = $true)]
  [string]$ZCodeExe,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $ZCodeExe).Path
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw 'ZCodeExe must point to the installed ZCode.exe file.'
}
$cli = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\overlay-cli.mjs'
$previous = $env:ELECTRON_RUN_AS_NODE
$previousEncoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $env:ELECTRON_RUN_AS_NODE = '1'
  $arguments = @($cli, 'setup')
  if ($Force) { $arguments += '--force' }
  & $exe @arguments | Out-Host
  $result = $LASTEXITCODE
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previous
  [Console]::OutputEncoding = $previousEncoding
}
exit $result
