# Operator-invoked plugin installation. Install Git, herdr and Bun separately first.
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
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git for Windows (https://git-scm.com/download/win), then run this again.'
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) { throw 'Install herdr 0.9.0 or newer separately, then retry.' }
$herdrVersion = (Run-Tool herdr @('--version')) -replace '^herdr\s+', '' -replace '-.*$', ''
if ([version]$herdrVersion -lt [version]'0.9.0') {
    throw "Needs herdr 0.9.0 or newer; this is $herdrVersion. Update herdr and run this again."
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Install Bun 1.4 or newer separately, then retry.' }
$bunVersion = Run-Tool bun @('--version')
if ([version]($bunVersion -replace '-.*$', '') -lt [version]'1.4.0') { throw "Needs Bun 1.4 or newer; this is $bunVersion." }

$pluginId = 'devswha.herdr-web-ui'
function Find-Plugin {
    (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins |
        Where-Object { $_.plugin_id -eq $pluginId } | Select-Object -First 1
}
function Test-WindowsPlugin($Plugin) {
    $Plugin.plugin_root -and (Test-Path -LiteralPath (Join-Path $Plugin.plugin_root 'scripts\plugin.ps1'))
}
function Assert-ForkPlugin($Plugin) {
    try {
        $identity = Get-Content -Raw -LiteralPath (Join-Path $Plugin.plugin_root 'shared\distribution.ts')
        $remote = (Run-Tool git @('-C', $Plugin.plugin_root, 'config', '--local', '--get', 'remote.origin.url') | Out-String).Trim()
        if ($identity -match '(?m)^export const DISTRIBUTION_REPOSITORY = "tomrutsaert/herdr-web-ui";\r?$' -and
            $remote -match '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)tomrutsaert/herdr-web-ui(?:\.git)?$') { return }
    } catch { }
    throw 'Fork migration required: stop only the web plugin, preserve config/state, explicitly replace its checkout with tomrutsaert/herdr-web-ui, then restart the web plugin (INSTALL.md#fork-migration). Nothing was started or uninstalled.'
}
$plugin = Find-Plugin
if ($plugin) { Assert-ForkPlugin $plugin }
$newInstall = $false
if ($plugin -and -not (Test-WindowsPlugin $plugin)) {
    throw 'The installed fork copy has no Windows support. Stop the web plugin and explicitly replace its checkout; config/state must be preserved (INSTALL.md#fork-migration).'
}
if (-not $plugin) {
    if (-not $Ref) {
        $Ref = Run-Tool git @('ls-remote', '--tags', '--refs', 'https://github.com/tomrutsaert/herdr-web-ui.git', 'fork-v*') |
            ForEach-Object { if ($_ -match 'refs/tags/(fork-v\d+\.\d+\.\d+)$') { $Matches[1] } } |
            Sort-Object { [version]$_.Substring(6) } | Select-Object -Last 1
    }
    if (-not $Ref) { throw 'Could not find the latest app release on GitHub. Check your connection and run this again.' }
    if ($Ref -match '^(v\d|(?:fork-)?remote-v)') { throw 'App installs require a fork-v release tag or an explicit development branch/commit.' }
    Write-Host "herdr web ui: installing the plugin at $Ref"
    Run-Tool herdr @('plugin', 'install', 'tomrutsaert/herdr-web-ui', '--ref', $Ref, '--yes')
    $newInstall = $true
    $plugin = Find-Plugin
    if (-not $plugin.plugin_root) { throw 'herdr does not list the plugin after installing it. See: herdr plugin list' }
    Assert-ForkPlugin $plugin
    # herdr installs a release without Windows build steps as a success that cannot start.
    if (-not (Test-WindowsPlugin $plugin)) { throw "herdr web ui $Ref does not support Windows yet. Run this again after the next release." }
} else { Write-Host 'herdr web ui: already installed; updates are an operator deployment step (INSTALL.md#update)' }

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
    if (-not $ready) {
        # The start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal.
        $why = ''
        try {
            $failed = (& herdr plugin log list | ConvertFrom-Json).result.logs |
                Where-Object { $_.plugin_id -eq $pluginId -and $_.stderr } | Select-Object -Last 1
            if ($failed) { $why = "`n" + $failed.stderr.Trim() }
        } catch { $why = '' } # the reason is a help, not a step: without it the pointer below still stands
        throw "The app did not start within 25 seconds.$why`nSee: herdr plugin log list"
    }
    Write-Host ($status | Where-Object { $_ -match '^running ' })
    $origin = [regex]::Match(($status | Where-Object { $_ -match '^running ' } | Select-Object -First 1), '^running (\S+)').Groups[1].Value
    $opened = $false
    if ($newInstall -and $origin -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(?:/|$)' -and
        -not $env:CI -and -not $env:HERDR_WEB_NO_OPEN -and -not $env:SSH_CONNECTION -and
        [Environment]::UserInteractive) {
        try {
            Start-Process $origin
            $opened = $true
            Write-Host "herdr web ui: opened $origin in your browser: click Install in the address bar to add the app"
        } catch { }
    }
    if ($newInstall -and -not $opened) {
        if ($env:SSH_CONNECTION) {
            $port = [regex]::Match($origin, ':(\d+)(?:/|$)').Groups[1].Value
            if (-not $port) {
                $scheme = [regex]::Match($origin, '^https?://').Value
                $port = if ($scheme -eq 'https://') { '443' } else { '80' }
            }
            Write-Host "herdr web ui: from your own computer, run: ssh -L ${port}:127.0.0.1:${port} <this-pc>, then open http://127.0.0.1:${port} and click Install in the address bar"
            Write-Host 'herdr web ui: Use an HTTPS reverse proxy or SSH tunnel, then Phone setup in herdr to pair'
        } elseif ($origin -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(?:/|$)') {
            Write-Host "herdr web ui: open $origin in your browser and click Install in the address bar"
        } else {
            Write-Host "herdr web ui: open $origin in your browser"
        }
    }
} else { Write-Host 'herdr web ui: starts with herdr. Open a new terminal and run: herdr' }
Write-Host 'herdr web ui: open Phone setup in herdr for phone access.'

}
