# install.ps1 — Instalador del Bot Herbalis para la PC del vendedor.
#
# TEMPLATE: make-installer.js reemplaza el placeholder CONFIG-B64 (abajo) con el
# config.json del vendedor en base64 y deja la copia lista en installer/dist/<seller>/.
# NO correr este template directo — correr el generado.
#
# Hace: Node 20+ (winget o MSI, unico paso con UAC) -> %LOCALAPPDATA%\HerbalisAgent
# -> descarga el agente desde Railway (/agent-dist) -> config.json -> npm install
# -> accesos directos (Escritorio + Inicio) -> lanza.

$ErrorActionPreference = 'Stop'
# Win10 + PowerShell 5.1 no negocia TLS 1.2 por default y Railway lo exige.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ── Config embebida (base64 esquiva el escaping del JWT y los acentos) ───────
$ConfigB64 = '__CONFIG_B64__'
if ($ConfigB64 -eq ('__CONFIG' + '_B64__')) { throw 'Este es el TEMPLATE. Genera el instalador con: node agent/installer/make-installer.js' }
$ConfigJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigB64))
$Cfg = $ConfigJson | ConvertFrom-Json
$ApiBase = $Cfg.apiBase.TrimEnd('/')
$Headers = @{ 'x-seller-id' = $Cfg.sellerId; 'x-agent-token' = $Cfg.token }
$Dest = Join-Path $env:LOCALAPPDATA 'HerbalisAgent'

Write-Host ''
Write-Host "Instalando el Bot Herbalis (vendedor: $($Cfg.sellerId)) en $Dest"
Write-Host ''

# ── 1. Node 20+ ───────────────────────────────────────────────────────────────
function Test-Node {
    try { $v = (& node -v) -replace '^v', ''; [int]($v.Split('.')[0]) -ge 20 } catch { $false }
}
if (-not (Test-Node)) {
    Write-Host '[1/6] Instalando Node.js 20 LTS...'
    $ok = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) { $ok = $true }
    }
    if (-not $ok) {
        # Fallback: MSI silencioso de nodejs.org. Version pinneada — bumpear a mano
        # cuando 20.x quede viejo. Unico paso que pide UAC (instala machine-wide).
        $msiUrl = 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi'
        $msi = Join-Path $env:TEMP 'node-lts.msi'
        Write-Host "  Descargando $msiUrl..."
        Invoke-WebRequest -Uri $msiUrl -OutFile $msi
        Start-Process msiexec -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Verb RunAs -Wait
    }
    # Refrescar el PATH de ESTA sesion (el instalador toco el PATH de maquina/usuario).
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Test-Node)) { throw 'Node.js no quedo instalado. Instalalo a mano desde nodejs.org y volve a correr este instalador.' }
} else {
    Write-Host '[1/6] Node.js ya instalado, OK.'
}

# ── 2. Carpeta ────────────────────────────────────────────────────────────────
Write-Host "[2/6] Creando $Dest..."
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# ── 3. Descargar el agente desde Railway ──────────────────────────────────────
Write-Host '[3/6] Descargando el bot desde el servidor...'
$man = Invoke-RestMethod -Uri "$ApiBase/agent-dist/manifest" -Headers $Headers
foreach ($name in $man.files.PSObject.Properties.Name) {
    Write-Host "  - $name"
    Invoke-WebRequest -Uri "$ApiBase/agent-dist/file/$name" -Headers $Headers -OutFile (Join-Path $Dest $name)
}

# ── 4. config.json (bytes exactos del JSON embebido) ──────────────────────────
[IO.File]::WriteAllBytes((Join-Path $Dest 'config.json'), [Convert]::FromBase64String($ConfigB64))

# ── 5. npm install ────────────────────────────────────────────────────────────
Write-Host '[4/6] Instalando dependencias (puede tardar varios minutos)...'
Push-Location $Dest
& cmd /c 'npm install --no-audit --no-fund'
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) { throw 'npm install fallo. Revisa la conexion a internet y volve a correr el instalador.' }

# ── 6. Accesos directos: Escritorio + carpeta Inicio (auto-arranque) ──────────
Write-Host '[5/6] Creando accesos directos...'
$ws = New-Object -ComObject WScript.Shell
# GetFolderPath y no $env:USERPROFILE\Desktop — soporta Escritorio movido a OneDrive.
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'))) {
    $lnk = $ws.CreateShortcut((Join-Path $folder 'Bot Herbalis.lnk'))
    $lnk.TargetPath = Join-Path $Dest 'run.bat'
    $lnk.WorkingDirectory = $Dest
    $lnk.Description = 'Bot Herbalis - agente de WhatsApp'
    $lnk.Save()
}

# ── 7. Lanzar ─────────────────────────────────────────────────────────────────
Write-Host '[6/6] Iniciando el bot...'
Start-Process -FilePath (Join-Path $Dest 'run.bat') -WorkingDirectory $Dest

Write-Host ''
Write-Host '=============================================================='
Write-Host ' LISTO. Se va a abrir una ventana de Chrome con un codigo QR.'
Write-Host ' Escanearlo con el WhatsApp del vendedor:'
Write-Host '   WhatsApp -> Ajustes -> Dispositivos vinculados -> Vincular'
Write-Host ''
Write-Host ' El bot arranca solo cada vez que se prende la PC.'
Write-Host ' Si se cierra por error: doble click en "Bot Herbalis"'
Write-Host ' del Escritorio.'
Write-Host '=============================================================='
