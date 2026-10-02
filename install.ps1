# Native Windows install: irm https://devswha.github.io/herdr-web-ui/install.ps1 | iex
param([string]$Ref = $env:HERDR_WEB_UI_REF)

& {
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'herdr web ui supports Windows x64. Use install.sh on Linux or macOS.'
}

function Run-Tool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed (exit $LASTEXITCODE). Fix the error above and run this again." }
}

# The official installers keep these user-local directories on PATH for future terminals.
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin;$env:PATH"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git for Windows (https://git-scm.com/download/win), then run this again.'
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
    Write-Host 'herdr web ui: installing herdr for your user'
    $installer = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName() + '.cmd')
    try {
        Invoke-WebRequest 'https://herdr.dev/install.cmd' -UseBasicParsing -OutFile $installer
        Run-Tool $installer @()
    } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
}
$herdrVersion = (Run-Tool herdr @('--version')) -replace '^herdr\s+', '' -replace '-.*$', ''
if ([version]$herdrVersion -lt [version]'0.9.0') {
    throw "Needs herdr 0.9.0 or newer; this is $herdrVersion. Update herdr and run this again."
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun -or [version]((Run-Tool bun @('--version')) -replace '-.*$', '') -lt [version]'1.4.0') {
    Write-Host 'herdr web ui: installing Bun 1.4.2 for your user'
    # The same stable runtime as CI; use Bun's official installer rather than a second downloader.
    & ([scriptblock]::Create((Invoke-WebRequest 'https://bun.sh/install.ps1' -UseBasicParsing).Content)) -Version '1.4.2'
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Bun did not install. See https://bun.sh.' }
$bunVersion = Run-Tool bun @('--version')
if ([version]($bunVersion -replace '-.*$', '') -lt [version]'1.4.0') { throw "Needs Bun 1.4 or newer; this is $bunVersion." }

$pluginId = 'devswha.herdr-web-ui'
$plugins = (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins
$plugin = $plugins | Where-Object { $_.plugin_id -eq $pluginId } | Select-Object -First 1
if (-not $plugin) {
    if (-not $Ref) {
        $Ref = Run-Tool git @('ls-remote', '--tags', '--refs', 'https://github.com/devswha/herdr-web-ui.git', 'v*') |
            ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } |
            Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
    }
    if (-not $Ref) { throw 'Could not find the latest app release on GitHub. Check your connection and run this again.' }
    Write-Host "herdr web ui: installing the plugin at $Ref"
    Run-Tool herdr @('plugin', 'install', 'devswha/herdr-web-ui', '--ref', $Ref, '--yes')
    $plugins = (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins
    $plugin = $plugins | Where-Object { $_.plugin_id -eq $pluginId } | Select-Object -First 1
} else { Write-Host 'herdr web ui: already installed; Settings > Updates keeps it current' }
if (-not $plugin.plugin_root) { throw 'herdr does not list the plugin after installing it. See: herdr plugin list' }

$server = Run-Tool herdr @('status', 'server', '--json') | ConvertFrom-Json
if ($server.running) {
    Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null
    $script = Join-Path $plugin.plugin_root 'scripts\plugin.ts'
    $ready = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        $status = Run-Tool bun @($script, 'status')
        if ($status -match '^running ') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'The app did not start within 25 seconds. See: herdr plugin log list' }
    Write-Host ($status | Where-Object { $_ -match '^running ' })
} else { Write-Host 'herdr web ui: starts with herdr. Open a new terminal and run: herdr' }
Write-Host 'herdr web ui: open Phone setup in herdr for phone access.'
}
