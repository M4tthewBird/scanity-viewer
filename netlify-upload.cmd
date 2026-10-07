@echo off
rem Prepares the viewer for a manual Netlify deploy: builds the Scanity viewer into site\
rem (npm run scanity:build), then opens it. Drag the opened site folder onto the viewer
rem site's Deploys page in Netlify.

cd /d "%~dp0"
call npm run scanity:build
if errorlevel 1 (
    echo Sestaveni selhalo.
    pause
    exit /b 1
)
echo Hotovo: slozka site je pripravena. Pretahni ji do Netlify (Deploys).
start "" explorer "%~dp0site"
