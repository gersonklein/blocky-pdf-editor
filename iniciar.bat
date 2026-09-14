@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Reentrada: a segunda instancia so espera o servidor subir e abre o navegador.
if "%~1"=="--abrir" goto :abrir

title Blocky PDF Editor

rem --- Procura o Python ---------------------------------------------------
set "PY="
py -3 -c "" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "" >nul 2>&1 && set "PY=python"
if not defined PY (
  echo.
  echo   [ERRO] Python nao encontrado.
  echo.
  echo   Instale em https://www.python.org/downloads/ e marque
  echo   "Add python.exe to PATH" durante a instalacao.
  echo.
  pause
  exit /b 1
)

rem --- Primeira porta livre a partir de 8777 -------------------------------
set "PORTA="
for %%P in (8777 8778 8779 8780 8781) do (
  if not defined PORTA (
    netstat -ano | findstr /r /c:":%%P .*LISTENING" >nul 2>&1
    if errorlevel 1 set "PORTA=%%P"
  )
)
if not defined PORTA (
  echo   [ERRO] Nenhuma porta livre entre 8777 e 8781.
  pause
  exit /b 1
)

echo.
echo   Blocky PDF Editor
echo   =================
echo.
echo   Endereco:  http://localhost:!PORTA!/index.html
echo   Pasta:     %CD%
echo.
echo   O navegador abre sozinho em alguns segundos.
echo   Feche esta janela (ou Ctrl+C) para parar o servidor.
echo.

start "" /min "%~f0" --abrir !PORTA!
%PY% "%~dp0servidor.py" !PORTA! "%~dp0."
exit /b

:abrir
rem Espera o servidor responder e abre o navegador padrao.
powershell -NoProfile -Command "$u='http://localhost:%~2/index.html'; for($i=0;$i -lt 40;$i++){ try{ Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $u ^| Out-Null; Start-Process $u; exit }catch{ Start-Sleep -Milliseconds 500 } }"
exit /b
