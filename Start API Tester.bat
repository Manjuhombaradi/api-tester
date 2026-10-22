@echo off
rem Windows: double-click to run API Tester from source (installs dependencies on first run).
rem   "Start API Tester.bat" run suite.apisuite   runs the command line version
rem The command line version keeps the current folder: relative suite, data and --out paths
rem are relative to where you are, not to the API Tester folder.
rem setlocal: variables and the folder change below end with this script (the console stays where it was)
setlocal
set "CALLER=%CD%"
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 22.13 or newer is required. Install the LTS version from https://nodejs.org
    echo or use the ready-made API Tester installer / portable .exe instead.
    pause
    exit /b 1
)
rem Electron's installer needs Node.js 22.13 or newer
node -e "var v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)" 2>nul
if errorlevel 1 (
    for /f "delims=" %%v in ('node -v') do echo Node.js 22.13 or newer is required, found %%v.
    echo Install the LTS version from https://nodejs.org
    echo or use the ready-made API Tester installer / portable .exe instead.
    pause
    exit /b 1
)

rem command line version (run / echo-server / --help): only the runtime dependencies are needed, no Electron
set "CLI="
if /i "%~1"=="run" set CLI=1
if /i "%~1"=="echo-server" set CLI=1
if /i "%~1"=="--help" set CLI=1
if /i "%~1"=="--version" set CLI=1
if /i "%~1"=="help" set CLI=1
if /i "%~1"=="-h" set CLI=1
if /i "%~1"=="-v" set CLI=1
if /i "%~1"=="--cli" set CLI=1
if not defined CLI goto desktop
if exist node_modules goto runcli
echo First run: installing dependencies (one time, needs internet)...
call npm install --no-audit --no-fund --omit=dev
if errorlevel 1 (
    echo npm install failed - check the internet connection and try again.
    exit /b 1
)
:runcli
cd /d "%CALLER%"
node "%~dp0src\cli.js" %*
exit /b %ERRORLEVEL%

:desktop
rem node_modules must match this OS / CPU (Electron's binary is platform specific): a folder copied
rem from or shared with another machine is reinstalled once.
set "SYSTEM=%OS%-%PROCESSOR_ARCHITECTURE%"
if not exist node_modules goto firstrun
set "HAVE="
if exist node_modules\.installed-for set /p HAVE=<node_modules\.installed-for
if "%HAVE%"=="%SYSTEM%" goto start
set "ELECTRON_BINARY="
if exist node_modules\electron\path.txt set /p ELECTRON_BINARY=<node_modules\electron\path.txt
if exist node_modules\.installed-for goto reinstall
if defined ELECTRON_BINARY if not "%ELECTRON_BINARY%"=="electron.exe" goto reinstall
rem no marker yet: an earlier install may have been interrupted - npm install completes it (quick when complete)
echo Checking dependencies (one time)...
goto install

:firstrun
echo First run: installing dependencies (one time, needs internet)...
goto install

:reinstall
echo node_modules was installed on another system - reinstalling for %SYSTEM% (one time, needs internet)...
rem Electron downloads the binary for this system on the next start
if exist node_modules\electron\dist rmdir /s /q node_modules\electron\dist
if exist node_modules\electron\path.txt del /q node_modules\electron\path.txt

:install
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo npm install failed - check the internet connection and try again.
    pause
    exit /b 1
)
>node_modules\.installed-for echo %SYSTEM%

:start
call npm start -- %*
exit /b %ERRORLEVEL%
