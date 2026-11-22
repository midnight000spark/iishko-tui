[CmdletBinding()]
param(
    [string]$ConfigHome,
    [switch]$NonInteractive,
    [switch]$Replace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Never inherit PowerShell 7 or user module lookup paths through an intermediate host.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$ExpectedVersion = '__RELEASE_VERSION__'
$PayloadNames = @('package.json', 'tui.js', 'THIRD-PARTY-NOTICES.txt')
$PluginNames = @('package.json', 'tui.js', 'THIRD-PARTY-NOTICES.txt', 'release-manifest.json')

function Assert-PlainPath([string]$Path) {
    $current = [System.IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Symlinks, junctions and other reparse points are not supported. Use a plain local directory.'
            }
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Assert-Names($Actual, $Expected) {
    if ((@($Actual | Sort-Object) -join '|') -cne (@($Expected | Sort-Object) -join '|')) {
        throw 'Unexpected files or missing files. Extract a fresh trusted release ZIP.'
    }
}

function Assert-Plugin([string]$Directory, [string]$Version) {
    Assert-PlainPath $Directory
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { throw 'Plugin folder is missing.' }
    $items = @(Get-ChildItem -LiteralPath $Directory -Force)
    Assert-Names @($items | ForEach-Object { $_.Name }) $PluginNames
    foreach ($item in $items) {
        Assert-PlainPath $item.FullName
        if ($item.PSIsContainer -or $item.Length -gt 33554432) { throw 'Invalid plugin payload.' }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -cne 'iishko-tui' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or $manifest.minimumOpenCode -cne '2.2.5') {
        throw 'Unsupported release identity.'
    }
    if ($Version -and $manifest.version -cne $Version) { throw 'Installer and release versions differ.' }
    Assert-Names @($manifest.files.PSObject.Properties | ForEach-Object { $_.Name }) $PayloadNames
    foreach ($name in $PayloadNames) {
        $expected = $manifest.files.PSObject.Properties[$name].Value
        if ($expected -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid SHA-256 manifest.' }
        $actual = (Get-FileHash -LiteralPath (Join-Path $Directory $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -cne $expected) { throw "Checksum mismatch: $name. Extract a fresh trusted ZIP." }
    }
    $package = Get-Content -LiteralPath (Join-Path $Directory 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Names @($package.PSObject.Properties | ForEach-Object { $_.Name }) @('name', 'version', 'private', 'type', 'exports')
    Assert-Names @($package.exports.PSObject.Properties | ForEach-Object { $_.Name }) @('./tui')
    if ($package.name -cne 'iishko-tui' -or $package.version -cne $manifest.version -or $package.type -cne 'module' -or $package.private -ne $true -or $package.exports.'./tui' -cne './tui.js') {
        throw 'Invalid plugin package entrypoint.'
    }
}

function Confirm-Action([string]$Message) {
    if ($NonInteractive) { return }
    if ((Read-Host "$Message Type YES to continue") -cne 'YES') { throw 'Cancelled. Nothing was installed.' }
}

function Assert-OpenCode {
    $command = Get-Command opencode -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        Write-Warning 'OpenCode was not found on PATH. Files may be copied, but OpenCode V2 >= 2.2.5 must already be installed before use.'
        return
    }
    $global:LASTEXITCODE = 0
    $versionText = (& $command.Source --version 2>&1 | Out-String).Trim()
    $versionMatch = [regex]::Match($versionText, '^(?:opencode\s+)?(2\.\d+\.\d+)$')
    if ($LASTEXITCODE -ne 0 -or -not $versionMatch.Success) {
        throw 'Cannot confirm a compatible stable OpenCode V2 version. Require >= 2.2.5; no OpenCode was downloaded or started.'
    }
    if ([version]$versionMatch.Groups[1].Value -lt [version]'2.2.5') { throw 'OpenCode V2 >= 2.2.5 is required. Update OpenCode separately.' }
}

$lock = $null
$stage = $null
$backup = $null
$destination = $null
$installed = $false
try {
    Write-Host 'Install iishko-tui: local OpenCode configuration catalog and model refresh.'
    Write-Host 'Only install code from a trusted sender. SHA-256 checks detect corruption, not a malicious sender.'
    Write-Host 'No credentials, provider config, cli.json or system execution policy will be changed.'
    Assert-PlainPath $PSScriptRoot
    Assert-Names @(Get-ChildItem -LiteralPath $PSScriptRoot -Force | ForEach-Object { $_.Name }) @('README.md', 'windows-smoke.md', 'install.cmd', 'install.ps1', 'iishko-tui')
    foreach ($name in @('README.md', 'windows-smoke.md', 'install.cmd', 'install.ps1')) {
        $path = Join-Path $PSScriptRoot $name
        Assert-PlainPath $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Invalid release instructions or launcher.' }
    }
    $source = Join-Path $PSScriptRoot 'iishko-tui'
    Assert-Plugin $source $ExpectedVersion
    Assert-OpenCode
    if ($NonInteractive -and -not $ConfigHome) { throw 'Automation must supply an explicit -ConfigHome fixture directory.' }
    if (-not $ConfigHome) {
        if ($env:XDG_CONFIG_HOME) { $ConfigHome = $env:XDG_CONFIG_HOME }
        elseif ($env:USERPROFILE) { $ConfigHome = Join-Path $env:USERPROFILE '.config' }
        else { throw 'Cannot find a user configuration directory.' }
    }
    if (-not [System.IO.Path]::IsPathRooted($ConfigHome) -or $ConfigHome.StartsWith('\\')) {
        throw 'ConfigHome must be an absolute local path, not a network share.'
    }
    $configRoot = [System.IO.Path]::GetFullPath($ConfigHome)
    $config = Join-Path $configRoot 'opencode'
    $plugins = Join-Path $config 'plugins'
    $destination = Join-Path $plugins 'iishko-tui'
    Assert-PlainPath $destination
    $sourcePath = [System.IO.Path]::GetFullPath($source)
    if ($sourcePath -eq $destination -or $sourcePath.StartsWith($plugins + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Extract the release outside the plugins discovery directory before installation.'
    }
    if ($config.StartsWith($PSScriptRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The configuration destination cannot be inside the extracted release.'
    }
    Write-Host "Destination: $destination"
    Write-Host 'Close OpenCode before replacing plugin files, then open it again after installation.'
    Confirm-Action 'Copy this plugin code into your user plugins folder?'
    [System.IO.Directory]::CreateDirectory($config) | Out-Null
    Assert-PlainPath $config
    # Exclusive handle serializes installers without a stale lock-file stealing policy.
    $lockPath = Join-Path $config '.iishko-install.lock'
    Assert-PlainPath $lockPath
    $lock = [System.IO.FileStream]::new($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::DeleteOnClose)
    Assert-PlainPath $destination
    $exists = Test-Path -LiteralPath $destination
    if ($exists) {
        Assert-Plugin $destination ''
        if ($NonInteractive -and -not $Replace) { throw 'Existing plugin: automation requires explicit -Replace.' }
        Confirm-Action 'Replace the verified existing plugin? Its backup will be kept outside plugins.'
    }
    # Both staging and backups must stay OUTSIDE auto-discovered plugins/.
    $stage = Join-Path $config ('.iishko-stage-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($stage) | Out-Null
    foreach ($name in $PluginNames) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $stage $name)
    }
    Assert-Plugin $stage $ExpectedVersion
    [System.IO.Directory]::CreateDirectory($plugins) | Out-Null
    Assert-PlainPath $destination
    if ($exists) {
        Assert-Plugin $destination ''
        $backupRoot = Join-Path $config 'iishko-plugin-backups'
        Assert-PlainPath $backupRoot
        [System.IO.Directory]::CreateDirectory($backupRoot) | Out-Null
        $backup = Join-Path $backupRoot ([guid]::NewGuid().ToString('N'))
        [System.IO.Directory]::Move($destination, $backup)
    }
    [System.IO.Directory]::Move($stage, $destination)
    $installed = $true
    Assert-Plugin $destination $ExpectedVersion
    Write-Host "Installed iishko-tui $ExpectedVersion. No OpenCode process was started."
    if ($backup) { Write-Host "Previous plugin backup: $backup" }
    Write-Host 'Open OpenCode; use /reload if needed, then Ctrl+P and search for iishko / catalog.'
    Write-Host 'See README.md for local-only scope, migration and recovery instructions.'
}
catch {
    $failure = $_.Exception.Message
    try {
        if ($installed) {
            Assert-PlainPath $destination
            [System.IO.Directory]::Move($destination, $stage)
            $installed = $false
        }
        if ($backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $destination)) {
            Assert-PlainPath $backup
            [System.IO.Directory]::Move($backup, $destination)
            Write-Warning 'Previous plugin restored after installation failure.'
        }
    }
    catch { Write-Warning "Automatic rollback could not finish. Preserve backup at: $backup. See README.md." }
    Write-Host "Installation failed: $failure"
    exit 1
}
finally {
    # Only remove our randomly named staging directory, never user configuration.
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        try {
            Assert-PlainPath $stage
            foreach ($item in @(Get-ChildItem -LiteralPath $stage -Force)) {
                Assert-PlainPath $item.FullName
                if ($item.PSIsContainer -or $PluginNames -cnotcontains $item.Name) { throw 'Unexpected staging contents; preserve for manual recovery.' }
            }
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
        catch { Write-Warning 'Staging cleanup refused; preserve this directory for manual inspection.' }
    }
    if ($null -ne $lock) { $lock.Dispose() }
}
