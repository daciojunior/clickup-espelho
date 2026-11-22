#!/bin/bash
# Instalador do pacote Clinical Frontier para Obsidian (macOS).
# Instala o Obsidian (se faltar), cria o cofre e configura os plugins:
# ClickUp Espelho, Iconic, Editing Toolbar e BRAT (atualizações automáticas).
# Uso: duplo clique. Se o macOS bloquear, veja o LEIA-ME.
# Opções para teste: VAULT=... TOKEN=... SEM_OBSIDIAN=1 SEM_PERGUNTAS=1
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
step() { printf '\n== %s\n' "$1"; }
ok()   { printf '   OK  %s\n' "$1"; }
warn() { printf '   !   %s\n' "$1"; }
# lê e grava JSON com o JavaScript que já vem no macOS (ou com o Node, se não houver osascript)
json() {
  if [ -x /usr/bin/osascript ]; then /usr/bin/osascript -l JavaScript "$HERE/mac-json.js" "$@"
  else node "$HERE/mac-json.js" "$@"; fi
}

VAULT_NAME="$(json get "$HERE/config.json" vaultName)"
REPO="$(json get "$HERE/config.json" repo)"

# ---- 1. Obsidian ----
step "Obsidian"
APP="/Applications/Obsidian.app"
[ -d "$APP" ] || APP="$HOME/Applications/Obsidian.app"
if [ -d "$APP" ]; then ok "já instalado"
elif [ "${SEM_OBSIDIAN:-}" = "1" ]; then warn "não instalado (pulado a pedido)"
elif command -v brew >/dev/null 2>&1; then
  echo "   instalando pelo Homebrew..."
  brew install --cask obsidian && APP="/Applications/Obsidian.app" && ok "instalado"
else
  echo "   baixando da página oficial..."
  URL="$(curl -fsSL https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest | grep -o 'https://[^"]*Obsidian-[0-9.]*\.dmg' | head -1)"
  TMP="$(mktemp -d)"
  if [ -n "$URL" ] && curl -fL "$URL" -o "$TMP/Obsidian.dmg"; then
    MNT="$(hdiutil attach "$TMP/Obsidian.dmg" -nobrowse | tail -1 | awk -F'\t' '{print $NF}')"
    cp -R "$MNT/Obsidian.app" /Applications/ && APP="/Applications/Obsidian.app" && ok "instalado"
    hdiutil detach "$MNT" >/dev/null 2>&1
  else
    warn "não consegui baixar. Instale por https://obsidian.md e rode este instalador de novo."
    read -r -p "Enter para sair" _; exit 1
  fi
fi

# ---- 2. Cofre ----
step "Cofre"
DEFAULT="$HOME/Documents/$VAULT_NAME"
VAULT="${VAULT:-}"
if [ -z "$VAULT" ]; then
  if [ "${SEM_PERGUNTAS:-}" = "1" ]; then VAULT="$DEFAULT"
  else
    echo "   Use uma pasta LOCAL (fora de iCloud / Google Drive / Dropbox)."
    read -r -p "   Pasta do cofre [Enter = $DEFAULT]: " VAULT
    VAULT="${VAULT:-$DEFAULT}"
  fi
fi
VAULT="${VAULT/#\~/$HOME}"
OBS="$VAULT/.obsidian"; PLUG="$OBS/plugins"
mkdir -p "$PLUG"
VAULT="$(cd "$VAULT" && pwd)"; OBS="$VAULT/.obsidian"; PLUG="$OBS/plugins"
ok "$VAULT"

# ---- 3. Plugins do pacote ----
step "Plugins"
ENABLED=""
for name in clickup-espelho iconic editing-toolbar; do
  src="$HERE/plugins/$name"
  [ -d "$src" ] || { warn "$name não veio no pacote"; continue; }
  mkdir -p "$PLUG/$name"
  for f in "$src"/*; do
    b="$(basename "$f")"
    # nunca sobrescreve configuração que já existe nesta máquina
    [ "$b" = "data.json" ] && [ -f "$PLUG/$name/data.json" ] && continue
    cp "$f" "$PLUG/$name/$b"
  done
  ENABLED="$ENABLED $name"
  ok "$name"
done

# ---- 4. BRAT (baixado da página oficial) ----
BRAT="$PLUG/obsidian42-brat"; mkdir -p "$BRAT"; BRAT_OK=1
for f in main.js manifest.json styles.css; do
  curl -fsSL "https://github.com/TfTHacker/obsidian42-brat/releases/latest/download/$f" -o "$BRAT/$f" || BRAT_OK=0
done
if [ "$BRAT_OK" = "1" ]; then
  [ -n "$REPO" ] && json brat "$BRAT/data.json" "$REPO"
  ENABLED="obsidian42-brat$ENABLED"
  ok "BRAT (atualizações de $REPO)"
else
  rm -rf "$BRAT"
  warn "não consegui baixar o BRAT. O resto funciona; só não haverá atualização automática."
fi

# ---- 5. Token do ClickUp ----
step "Token do ClickUp"
DATA="$PLUG/clickup-espelho/data.json"
TOKEN="${TOKEN:-}"
if [ -f "$DATA" ]; then ok "configuração existente mantida"
else
  if [ -z "$TOKEN" ] && [ -f "$HERE/Clickup.env" ]; then
    TOKEN="$(grep -m1 '^CLICKUP_TOKEN=' "$HERE/Clickup.env" | cut -d= -f2- | tr -d '\r' | xargs)"
    [ -n "$TOKEN" ] && echo "   lido de Clickup.env"
  fi
  if [ -z "$TOKEN" ] && [ "${SEM_PERGUNTAS:-}" != "1" ]; then
    echo "   No ClickUp: avatar -> Settings -> Apps -> API Token (começa com pk_)."
    read -r -p "   Cole o seu token [Enter = configurar depois]: " TOKEN
    TOKEN="$(echo "$TOKEN" | xargs)"
  fi
  if [ -n "$TOKEN" ]; then
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: $TOKEN" https://api.clickup.com/api/v2/user)"
    if [ "$CODE" = "200" ]; then ok "token válido"
    else warn "o ClickUp recusou este token (resposta $CODE). Ele foi gravado mesmo assim; corrija depois nas configurações do plugin."; fi
  else warn "sem token: informe depois em Configurações -> ClickUp Espelho"; fi
  json data "$DATA" "$HERE/config.json" "$TOKEN"
fi

# ---- 6. Plugins ligados ----
# shellcheck disable=SC2086
json enable "$OBS/community-plugins.json" $ENABLED
[ -f "$OBS/app.json" ] || echo '{ "promptDelete": false }' > "$OBS/app.json"

# ---- 7. Registrar o cofre no Obsidian e abrir ----
step "Abrir o cofre"
REG="$HOME/Library/Application Support/obsidian/obsidian.json"
if [ "${SEM_OBSIDIAN:-}" = "1" ]; then warn "pulado a pedido"
elif pgrep -x Obsidian >/dev/null 2>&1; then warn "o Obsidian está aberto: use 'Abrir pasta como cofre' e escolha $VAULT"
else
  mkdir -p "$(dirname "$REG")"
  [ -f "$REG" ] && cp "$REG" "$REG.bak"
  if json register "$REG" "$VAULT"; then
    [ -d "$APP" ] && open -a "$APP" && ok "Obsidian aberto no cofre novo"
  else warn "não consegui registrar o cofre. Abra o Obsidian -> 'Abrir pasta como cofre' -> $VAULT"; fi
fi

printf '\nPronto. Falta 1 clique: quando o Obsidian perguntar, escolha\n'
printf '"Confiar no autor e ativar plugins" (Trust author and enable plugins).\n'
printf 'Em até 1 minuto as pastas Working e Desenvolvimento aparecem.\n'
[ "${SEM_PERGUNTAS:-}" = "1" ] || read -r -p "Enter para fechar" _
