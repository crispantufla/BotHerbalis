@echo off
setlocal enabledelayedexpansion

echo ##########################################
echo #    HERBALIS - INSTALADOR Y LANZADOR    #
echo ##########################################
echo.

:: 1. Verificar si Node.js está instalado
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado. 
    echo Por favor, instala Node.js desde https://nodejs.org/ antes de continuar.
    pause
    exit /b
)

echo [+] Instalando dependencias del Servidor (Backend)...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Error instalando dependencias del servidor.
    pause
    exit /b
)

echo.
echo [+] Instalando dependencias del Panel (Frontend)...
cd client
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Error instalando dependencias del frontend.
    pause
    exit /b
)
cd ..

echo.
echo [+] Verificando archivo .env...
if not exist .env (
    echo [AVISO] No se encontro el archivo .env. 
    echo Creando uno basado en .env.example...
    copy .env.example .env
    echo [IMPORTANTE] Edita el archivo .env con tu GEMINI_API_KEY y ADMIN_NUMBER antes de volver a ejecutar.
    pause
    exit /b
)

echo.
echo [+] Iniciando Herbalis (Backend + Frontend)...
echo [INFO] Se abrira una ventana con los logs del sistema.
echo.
npm start

pause
