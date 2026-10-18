# Installer decisions against stand-ins; never downloads tools or changes a real plugin.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
$oldNoOpen = $env:HERDR_WEB_NO_OPEN
$state = @{ installed = $false; installs = 0; started = 0; bunVersion = '1.4.2' }
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
New-Item -ItemType Directory -Path (Join-Path $scratch 'shared') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $scratch 'scripts') -Force | Out-Null
Set-Content (Join-Path $scratch 'shared\distribution.ts') 'export const DISTRIBUTION_REPOSITORY = "tomrutsaert/herdr-web-ui";'
Set-Content (Join-Path $scratch 'scripts\plugin.ps1') '# fixture'
function bun {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { $state.bunVersion } else { 'running http://127.0.0.1:7317' }
}
function git { $global:LASTEXITCODE = 0; 'https://github.com/tomrutsaert/herdr-web-ui.git' }
function herdr {
    $global:LASTEXITCODE = 0
    $command = $args -join ' '
    switch -Wildcard ($command) {
        '--version' { 'herdr 0.9.3' }
        'plugin list --json' {
            $plugins = if ($state.installed) { @(@{ plugin_id = 'devswha.herdr-web-ui'; plugin_root = $scratch; version = '1.0.0' }) } else { @() }
            @{ result = @{ plugins = $plugins } } | ConvertTo-Json -Depth 5 -Compress
        }
        'plugin install *' { $state.installs++; $state.installed = $true }
        'status server --json' { '{"running":true}' }
        'plugin action invoke *' { $state.started++ }
        default { throw "Unexpected herdr command: $command" }
    }
}
try {
    $env:HERDR_WEB_NO_OPEN = '1'
    & $installer -Ref 'fixture-revision'
    Assert ($state.installs -eq 1 -and $state.started -eq 1) 'An explicit install must build the plugin and start it when herdr runs.'
    & $installer -Ref 'fixture-revision'
    Assert ($state.installs -eq 1) 'A verified existing plugin must not be replaced implicitly.'
    $state.bunVersion = '1.3.0'
    $failed = $false
    try { & $installer -Ref 'fixture-revision' } catch { $failed = $_.Exception.Message -match 'Needs Bun' }
    Assert $failed 'An unsupported prerequisite must fail with installation left to the operator.'
    Assert ($state.installs -eq 1) 'Prerequisite failure must occur before plugin installation.'
    Write-Host 'PASS operator install, existing fork preservation and prerequisite validation'
} finally {
    $env:HERDR_WEB_NO_OPEN = $oldNoOpen
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
