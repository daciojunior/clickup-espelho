# Instalador do pacote Clinical Frontier para Obsidian (Windows).
# Instala o Obsidian (se faltar), cria o cofre e configura os plugins:
# ClickUp Espelho, Iconic, Editing Toolbar e BRAT (atualizacoes automaticas).
# Uso normal: duplo clique em "Instalar-Windows.bat".
# Texto sem acentos de proposito: o PowerShell 5 le scripts sem BOM como ANSI.
param(
  [string]$Vault = "",
  [string]$Token = "",
  [switch]$SemObsidian,   # nao instala nem abre o Obsidian (para teste)
  [switch]$SemPerguntas   # usa os padroes sem perguntar
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding $false
function Read-Json($p) { [IO.File]::ReadAllText($p, $utf8) | ConvertFrom-Json }
function Write-Json($p, $o) { [IO.File]::WriteAllText($p, ($o | ConvertTo-Json -Depth 20), $utf8) }
function Step($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   !   $m" -ForegroundColor Yellow }

$cfg = Read-Json (Join-Path $here "config.json")

# ---- 1. Obsidian ----
Step "Obsidian"
$exes = @("$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe", "$env:LOCALAPPDATA\Obsidian\Obsidian.exe", "$env:ProgramFiles\Obsidian\Obsidian.exe")
$exe = $exes | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) { Ok "ja instalado" }
elseif ($SemObsidian) { Warn "nao instalado (pulado a pedido)" }
elseif (Get-Command winget -ErrorAction SilentlyContinue) {
  Write-Host "   instalando pelo winget..."
  winget install -e --id Obsidian.Obsidian --accept-source-agreements --accept-package-agreements
  $exe = $exes | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) { Ok "instalado" } else { Warn "o winget terminou, mas nao achei o Obsidian. Instale por https://obsidian.md e rode de novo." }
}
else { Warn "winget nao encontrado. Instale o Obsidian por https://obsidian.md e rode este instalador de novo."; Read-Host "Enter para sair"; exit 1 }

# ---- 2. Cofre ----
Step "Cofre"
$default = Join-Path ([Environment]::GetFolderPath("MyDocuments")) $cfg.vaultName
if (-not $Vault) {
  if ($SemPerguntas) { $Vault = $default }
  else {
    Write-Host "   Use uma pasta LOCAL (fora de Google Drive / OneDrive)."
    $Vault = Read-Host "   Pasta do cofre [Enter = $default]"
    if (-not $Vault) { $Vault = $default }
  }
}
$Vault = [IO.Path]::GetFullPath($Vault)
$obs = Join-Path $Vault ".obsidian"
$plug = Join-Path $obs "plugins"
New-Item -ItemType Directory -Force -Path $plug | Out-Null
Ok $Vault

# ---- 3. Plugins do pacote ----
Step "Plugins"
$enabled = @()
foreach ($name in @("clickup-espelho", "iconic", "editing-toolbar")) {
  $src = Join-Path $here "plugins\$name"
  if (-not (Test-Path $src)) { Warn "$name nao veio no pacote"; continue }
  $dst = Join-Path $plug $name
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($f in Get-ChildItem $src -File) {
    # nunca sobrescreve configuracao que ja existe nesta maquina
    if ($f.Name -eq "data.json" -and (Test-Path (Join-Path $dst "data.json"))) { continue }
    Copy-Item $f.FullName (Join-Path $dst $f.Name) -Force
  }
  $enabled += $name
  Ok $name
}

# ---- 4. BRAT (baixado da pagina oficial) ----
$brat = Join-Path $plug "obsidian42-brat"
try {
  New-Item -ItemType Directory -Force -Path $brat | Out-Null
  foreach ($f in @("main.js", "manifest.json", "styles.css")) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/TfTHacker/obsidian42-brat/releases/latest/download/$f" -OutFile (Join-Path $brat $f)
  }
  $bd = Join-Path $brat "data.json"
  if ($cfg.repo) {
    if (Test-Path $bd) { $b = Read-Json $bd } else {
      $b = [pscustomobject]@{ pluginList = @(); pluginSubListFrozenVersion = @(); themesList = @(); updateAtStartup = $true; updateThemesAtStartup = $true; enableAfterInstall = $true; loggingEnabled = $false; loggingPath = "BRAT-log"; loggingVerboseEnabled = $false; debuggingMode = $false; notificationsEnabled = $true; globalTokenName = ""; personalAccessToken = ""; selectLatestPluginVersionByDefault = $false; allowIncompatiblePlugins = $false }
    }
    if (@($b.pluginList) -notcontains $cfg.repo) {
      $b.pluginList = @($b.pluginList) + $cfg.repo
      $b.pluginSubListFrozenVersion = @($b.pluginSubListFrozenVersion) + [pscustomobject]@{ repo = $cfg.repo; version = "latest" }
    }
    Write-Json $bd $b
  }
  $enabled = @("obsidian42-brat") + $enabled
  Ok "BRAT (atualizacoes de $($cfg.repo))"
} catch { Warn "nao consegui baixar o BRAT ($($_.Exception.Message)). O resto funciona; so nao havera atualizacao automatica." }

# ---- 5. Token do ClickUp ----
Step "Token do ClickUp"
$data = Join-Path $plug "clickup-espelho\data.json"
if (Test-Path $data) { Ok "configuracao existente mantida" }
else {
  $envFile = Join-Path $here "Clickup.env"
  if (-not $Token -and (Test-Path $envFile)) {
    $m = [regex]::Match([IO.File]::ReadAllText($envFile), "(?m)^CLICKUP_TOKEN=(.*)$")
    if ($m.Success) { $Token = $m.Groups[1].Value.Trim(); Write-Host "   lido de Clickup.env" }
  }
  if (-not $Token -and -not $SemPerguntas) {
    Write-Host "   No ClickUp: avatar -> Settings -> Apps -> API Token (comeca com pk_)."
    $Token = (Read-Host "   Cole o seu token [Enter = configurar depois]").Trim()
  }
  if ($Token) {
    try {
      $u = Invoke-RestMethod -Uri "https://api.clickup.com/api/v2/user" -Headers @{ Authorization = $Token }
      Ok "token valido (usuario: $($u.user.username))"
    } catch { Warn "o ClickUp recusou este token. Ele foi gravado mesmo assim; corrija depois nas configuracoes do plugin." }
  } else { Warn "sem token: informe depois em Configuracoes -> ClickUp Espelho" }
  # space: vem do config.json ou e procurado pelo nome na conta do token
  $spaces = @()
  if ($cfg.PSObject.Properties.Name -contains "spaces") { $spaces = @($cfg.spaces) }
  elseif ($Token -and $cfg.spaceName) {
    try {
      $h = @{ Authorization = $Token }
      foreach ($t in (Invoke-RestMethod -Uri "https://api.clickup.com/api/v2/team" -Headers $h).teams) {
        foreach ($sp in (Invoke-RestMethod -Uri "https://api.clickup.com/api/v2/team/$($t.id)/space?archived=false" -Headers $h).spaces) {
          if ($sp.name -eq $cfg.spaceName) { $spaces += [pscustomobject]@{ teamId = "$($t.id)"; id = "$($sp.id)"; name = "$($sp.name)" } }
        }
      }
    } catch { }
    if ($spaces.Count) { Ok "space encontrado: $($cfg.spaceName)" }
    else { Warn "nao achei o space '$($cfg.spaceName)' nesta conta. Escolha depois em Configuracoes -> ClickUp Espelho -> Carregar spaces." }
  }
  Write-Json $data ([pscustomobject]@{ settings = [pscustomobject]@{ token = $Token; spaces = @($spaces) } })
}

# ---- 6. Plugins ligados ----
$cp = Join-Path $obs "community-plugins.json"
$list = @()
if (Test-Path $cp) { $list = @(Read-Json $cp) }
foreach ($n in $enabled) { if ($list -notcontains $n) { $list += $n } }
[IO.File]::WriteAllText($cp, (ConvertTo-Json @($list)), $utf8)
$app = Join-Path $obs "app.json"
if (-not (Test-Path $app)) { [IO.File]::WriteAllText($app, '{ "promptDelete": false }', $utf8) }

# ---- 7. Registrar o cofre no Obsidian e abrir ----
Step "Abrir o cofre"
$running = Get-Process Obsidian -ErrorAction SilentlyContinue
$reg = Join-Path $env:APPDATA "obsidian\obsidian.json"
if ($SemObsidian) { Warn "pulado a pedido" }
elseif ($running) { Warn "o Obsidian esta aberto: use 'Abrir pasta como cofre' e escolha $Vault" }
else {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $reg) | Out-Null
    if (Test-Path $reg) { Copy-Item $reg "$reg.bak" -Force; $o = Read-Json $reg } else { $o = [pscustomobject]@{} }
    if (-not ($o.PSObject.Properties.Name -contains "vaults")) { $o | Add-Member -NotePropertyName vaults -NotePropertyValue ([pscustomobject]@{}) }
    $known = $false
    foreach ($p in $o.vaults.PSObject.Properties) {
      $same = $p.Value.path -eq $Vault
      if ($same) { $known = $true }
      if ($p.Value.PSObject.Properties.Name -contains "open") { $p.Value.open = $same } elseif ($same) { $p.Value | Add-Member -NotePropertyName open -NotePropertyValue $true }
    }
    if (-not $known) {
      $id = -join ((1..16) | ForEach-Object { "{0:x}" -f (Get-Random -Maximum 16) })
      $ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      $o.vaults | Add-Member -NotePropertyName $id -NotePropertyValue ([pscustomobject]@{ path = $Vault; ts = $ts; open = $true })
    }
    Write-Json $reg $o
    if ($exe) { Start-Process $exe; Ok "Obsidian aberto no cofre novo" }
  } catch { Warn "nao consegui registrar o cofre ($($_.Exception.Message)). Abra o Obsidian -> 'Abrir pasta como cofre' -> $Vault" }
}

Write-Host ""
Write-Host "Pronto. Falta 1 clique: quando o Obsidian perguntar, escolha" -ForegroundColor Green
Write-Host "'Confiar no autor e ativar plugins' (Trust author and enable plugins)." -ForegroundColor Green
Write-Host "Em ate 1 minuto as pastas Working e Desenvolvimento aparecem."
if (-not $SemPerguntas) { Read-Host "Enter para fechar" }
