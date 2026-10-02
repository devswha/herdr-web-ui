# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$originalPath = $env:PATH
$state = @{ installed = $false; installs = 0; ref = ''; running = $true; started = $false; failInstall = $false; bunVersion = '1.4.2'; failBun = $false }
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

# Tool boundaries only: no downloads, installed plugins, processes or user settings are changed.
function git {
    $global:LASTEXITCODE = 0
    "aaa`trefs/tags/v1.9.0"
    "bbb`trefs/tags/v1.10.0"
    "ccc`trefs/tags/v2.0.0-rc.1"
    "ddd`trefs/tags/remote-v99"
}
function bun {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { $state.bunVersion }
    elseif ($args[-1] -eq 'status') { 'running http://127.0.0.1:7317'; 'config: none' }
    else { throw "Unexpected Bun command: $args" }
}
function herdr {
    $global:LASTEXITCODE = 0
    switch ($args -join ' ') {
        '--version' { 'herdr 0.9.3' }
        'plugin list --json' {
            $plugins = @()
            if ($state.installed) { $plugins = @(@{ plugin_id = 'devswha.herdr-web-ui'; plugin_root = 'C:\Plugin with spaces' }) }
            @{ result = @{ plugins = $plugins } } | ConvertTo-Json -Depth 4 -Compress
        }
        'status server --json' { @{ running = $state.running } | ConvertTo-Json -Compress }
        'plugin action invoke devswha.herdr-web-ui.start-windows' { $state.started = $true; '{}' }
        default {
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'install') {
                if ($state.failInstall) { $global:LASTEXITCODE = 1; return }
                $state.installed = $true; $state.installs++; $state.ref = $args[4]
                'Installed herdr web ui'
            } else { throw "Unexpected herdr command: $args" }
        }
    }
}
function Invoke-WebRequest {
    if ($args[0] -ne 'https://bun.sh/install.ps1') { throw "Unexpected download: $args" }
    if ($state.failBun) { return @{ Content = 'param($Version)' } }
    @{ Content = 'param($Version) $state.bunVersion = $Version' }
}

try {
    & $installer -Ref ''
    Assert ($state.installed -and $state.ref -eq 'v1.10.0' -and $state.started) 'Install must choose the highest stable release and start a running server'
    & $installer -Ref ''
    Assert ($state.installs -eq 1) 'Rerun must preserve the installed plugin'
    & {
        $ErrorActionPreference = 'Continue'
        Invoke-Expression (Get-Content -Raw $installer)
        Assert ($ErrorActionPreference -eq 'Continue') 'The one-line installer must preserve the caller error preference'
        Assert (-not (Test-Path Function:\Run-Tool)) 'The one-line installer must keep helper functions in its own scope'
    }

    $state.bunVersion = '1.3.0'
    & $installer -Ref ''
    Assert ($state.bunVersion -eq '1.4.2') 'An old Bun must be updated through its installer'
    $state.bunVersion = '1.3.0'; $state.failBun = $true
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'Needs Bun' }
    Assert $failed 'An unsuccessful Bun bootstrap must stop installation'
    $state.bunVersion = '1.4.2'; $state.failBun = $false

    $state.installed = $false; $state.running = $false; $state.started = $false
    & $installer -Ref 'feat/windows-install'
    Assert ($state.ref -eq 'feat/windows-install' -and -not $state.started) 'Explicit ref must install without starting herdr'

    $state.installed = $false; $state.failInstall = $true; $state.started = $false
    $failed = $false
    try { & $installer -Ref 'broken' } catch { $failed = $_.Exception.Message -match 'herdr failed' }
    Assert ($failed -and -not $state.started) 'A failed native command must stop installation'
    Write-Host 'PASS native installer release selection, rerun, Bun bootstrap, explicit ref, stopped herdr and install failure'
} finally { $env:PATH = $originalPath }
