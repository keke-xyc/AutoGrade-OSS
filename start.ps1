param([string]$BindAddress = '127.0.0.1')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    throw 'Create .venv with Python 3.12+ and install requirements.lock.txt first.'
}
& $taskPython -m uvicorn app:app --host $BindAddress --port 8000 --workers 1
