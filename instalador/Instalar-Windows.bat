@echo off
rem Instalador Clinical Frontier para Obsidian (Windows). Duplo clique para rodar.
if not exist "%~dp0instalar.ps1" (
  echo.
  echo  ATENCAO: o zip nao foi extraido.
  echo  Clique com o botao direito no zip, escolha "Extrair tudo" e rode
  echo  o Instalar-Windows.bat de dentro da pasta extraida.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
if errorlevel 1 pause
