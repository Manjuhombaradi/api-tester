@echo off
rem API Tester command line for Windows (installed as <install folder>\bin\api-tester.cmd).
rem Runs the app's CLI with Electron's built-in Node.js, without opening a window:
rem   "%LOCALAPPDATA%\Programs\api-tester\bin\api-tester.cmd" run suite.apisuite --env Staging
rem Add the bin folder to PATH to type just: api-tester run suite.apisuite
rem Needs Electron's RunAsNode fuse (package.json build.electronFuses.runAsNode: true, see SECURITY.md).
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\API Tester.exe" "%~dp0..\resources\app.asar\src\cli.js" %*
exit /b %ERRORLEVEL%
