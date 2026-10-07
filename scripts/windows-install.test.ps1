# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$originalPath = $env:PATH
$originalLocalAppData = $env:LOCALAPPDATA
$originalUserProfile = $env:USERPROFILE
$state = @{ installed = $false; installs = 0; uninstalls = 0; ref = ''; running = $true; started = $false; failInstall = $false; bunVersion = '1.4.2'; failBun = $false; windowsRelease = $true }
# The gh sign-in's star: 'yes', 'no', or 'unknown' as when gh has no sign-in. No real star is given or read.
$star = @{ starred = 'unknown'; given = 0; asked = 0; answer = ''; failGive = $false; failAsk = $false }
# A real directory: the installer reads the installed copy to tell whether it can run on Windows.
$pluginRoot = Join-Path ([IO.Path]::GetTempPath()) "herdr plugin with spaces $PID"
$launcher = Join-Path $pluginRoot 'scripts\plugin.ps1'
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
            if ($state.installed) { $plugins = @(@{ plugin_id = 'devswha.herdr-web-ui'; plugin_root = $pluginRoot }) }
            @{ result = @{ plugins = $plugins } } | ConvertTo-Json -Depth 4 -Compress
        }
        'status server --json' { @{ running = $state.running } | ConvertTo-Json -Compress }
        'plugin action invoke devswha.herdr-web-ui.start-windows' { $state.started = $true; '{}' }
        'plugin uninstall devswha.herdr-web-ui' { $state.installed = $false; $state.uninstalls++; 'Uninstalled' }
        default {
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'install') {
                if ($state.failInstall) { $global:LASTEXITCODE = 1; return }
                $state.installed = $true; $state.installs++; $state.ref = $args[4]
                Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Force -Path (Split-Path $launcher) | Out-Null
                if ($state.windowsRelease) { Set-Content -LiteralPath $launcher -Value '' }
                'Installed herdr web ui'
            } else { throw "Unexpected herdr command: $args" }
        }
    }
}
function gh {
    if (($args -join ' ') -notmatch '^api --hostname github\.com (--method PUT )?user/starred/devswha/herdr-web-ui$') { throw "Unexpected gh command: $args" }
    $global:LASTEXITCODE = 0
    if ($args -contains 'PUT') {
        if ($star.failGive) { $global:LASTEXITCODE = 1; 'gh: Not Found (HTTP 404)' } else { $star.given++ }
    } elseif ($star.starred -eq 'no') { $global:LASTEXITCODE = 1; '{"message":"Not Found"}'; 'gh: Not Found (HTTP 404)' }
    elseif ($star.starred -ne 'yes') { $global:LASTEXITCODE = 4; 'To get started with GitHub CLI, please run:  gh auth login' }
}
function Read-Host {
    $star.asked++
    if ($star.failAsk) { throw 'Read-Host has no terminal to read from' }
    $star.answer
}
function Invoke-WebRequest {
    # herdr's installer, as the stand-in the test wrote: -OutFile is the last argument
    if ($args[0] -eq 'https://herdr.dev/install.cmd') { Set-Content -LiteralPath $args[-1] -Value $state.herdrInstaller -Encoding Ascii; return }
    if ($args[0] -ne 'https://bun.sh/install.ps1') { throw "Unexpected download: $args" }
    if ($state.failBun) { return @{ Content = 'param($Version)' } }
    # as Bun's installer does: the session is left with the user's PATH and nothing of the machine's
    @{ Content = 'param($Version) $state.bunVersion = $Version; $env:PATH = "C:\Users\someone\.bun\bin"' }
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
    Assert ($env:PATH.EndsWith($originalPath)) "Bun's installer must not leave the session without the machine PATH"
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

    # A copy from a release without Windows support: installed, listed, and unable to start.
    $state.failInstall = $false; $state.running = $true; $state.installed = $false; $state.windowsRelease = $false
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'does not support Windows yet' }
    Assert ($failed -and -not $state.started) 'A release without Windows support must not be reported as installed'
    $state.windowsRelease = $true; $installs = $state.installs
    & $installer -Ref ''
    Assert ($state.uninstalls -eq 1 -and $state.installs -eq $installs + 1 -and $state.started) 'A copy without Windows support must be replaced and started'
    Write-Host 'PASS native installer release selection, rerun, Bun bootstrap, explicit ref, stopped herdr, install failure and a copy without Windows support'

    # The star: mentioned once on a first install, asked only at a terminal, given only on "y".
    $mention = 'a GitHub star helps other herdr users find it'
    $firstInstall = { $state.installed = $false; $star.given = 0; $star.asked = 0; $star.failGive = $false; $star.failAsk = $false }
    & $firstInstall; $star.starred = 'yes'
    $said = & $installer -Ref '' 6>&1 | Out-String
    Assert ($said -notmatch $mention -and $star.asked -eq 0 -and $star.given -eq 0) "Someone who already starred must hear nothing of it: $said"
    & $firstInstall; $star.starred = 'unknown'
    $said = & $installer -Ref '' 6>&1 | Out-String
    Assert ($said -match $mention -and $star.asked -eq 0 -and $star.given -eq 0) "Without a gh sign-in the link is all there is: $said"
    $star.starred = 'no'
    $said = & $installer -Ref '' 6>&1 | Out-String
    Assert ($said -notmatch $mention -and $star.asked -eq 0) "A rerun must not mention the star again: $said"

    # Whether a terminal is there is the one answer a test host cannot give both ways: the installer's own text, with that line replaced.
    $source = Get-Content -Raw $installer
    $terminalCheck = 'function Test-Terminal \{[^\r\n]*\}'
    Assert ($source -match $terminalCheck) 'The installer must decide in Test-Terminal whether it may ask'
    $unattended = $source -replace $terminalCheck, 'function Test-Terminal { $false }'
    $atTerminal = $source -replace $terminalCheck, 'function Test-Terminal { $true }'
    & $firstInstall
    $said = Invoke-Expression $unattended 6>&1 | Out-String
    Assert ($said -match $mention -and $star.asked -eq 0 -and $star.given -eq 0) "An agent or a script must get the link and no question: $said"
    & $firstInstall; $star.answer = ''
    $said = Invoke-Expression $atTerminal 6>&1 | Out-String
    Assert ($said -match $mention -and $star.asked -eq 1 -and $star.given -eq 0) "Enter alone must not star: $said"
    & $firstInstall; $star.answer = 'n'
    Invoke-Expression $atTerminal 6>&1 | Out-Null
    Assert ($star.asked -eq 1 -and $star.given -eq 0) 'A refusal must not star'
    & $firstInstall; $star.answer = 'y'
    $said = Invoke-Expression $atTerminal 6>&1 | Out-String
    Assert ($star.asked -eq 1 -and $star.given -eq 1 -and $said -match 'starred\. Thank you') "A yes must star once: $said"
    & $firstInstall; $star.failGive = $true
    $said = Invoke-Expression $atTerminal 6>&1 | Out-String
    Assert ($star.given -eq 0 -and $said -match 'could not star it') "A star gh refuses must be said, not thrown: $said"
    & $firstInstall; $star.failAsk = $true
    $said = Invoke-Expression $atTerminal 6>&1 | Out-String
    Assert ($state.installed -and $star.asked -eq 1 -and $star.given -eq 0) "A question that cannot be asked must not fail the install: $said"
    $star.starred = 'unknown'; $star.failAsk = $false
    Write-Host 'PASS star: silent when starred or on a rerun, a link without gh or a terminal, asked once at a terminal and given only on yes'

    # A PC without herdr: its installer is a stand-in .cmd, and nothing of this PC's own herdr is in reach.
    $scratch = Join-Path ([IO.Path]::GetTempPath()) "herdr-installer-test-$PID"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $runs = Join-Path $scratch 'runs.txt'
    $marker = Join-Path $scratch 'second-run'
    $herdrStandIn = ${function:herdr}
    Remove-Item Function:\herdr
    $env:PATH = "$env:SystemRoot\System32"; $env:LOCALAPPDATA = $scratch; $env:USERPROFILE = $scratch
    Assert (-not (Get-Command herdr -ErrorAction SilentlyContinue)) 'The herdr installer cases need a session without herdr'
    $slow = 'echo curl: (28) Operation too slow. Less than 1024 bytes/sec transferred the last 30 seconds 1>&2'
    $attempts = { @(Get-Content -LiteralPath $runs -ErrorAction SilentlyContinue).Count }

    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'could not be downloaded' -and (& $attempts) -eq 2) "A download that fails twice must be tried twice and named as a download: $message"

    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'security software' -and (& $attempts) -eq 1) "A stop without a download error must not be retried: $message"

    # The second try succeeds: the script goes on to ask herdr its version, and this session has none.
    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nif exist `"$marker`" exit /b 0`r`necho.>`"$marker`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -and $message -notmatch 'could not be downloaded|did not finish' -and (& $attempts) -eq 2) "A download that succeeds on the second try must carry on: $message"
    Write-Host 'PASS herdr installer: a failed download is retried once and named, a silent stop is not retried'
} finally {
    $env:PATH = $originalPath
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:USERPROFILE = $originalUserProfile
    if ($herdrStandIn) { Set-Item Function:\herdr $herdrStandIn }
    if ($scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
}
