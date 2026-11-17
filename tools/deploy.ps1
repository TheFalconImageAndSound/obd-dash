# Publishes OBD Dash to GitHub Pages (free hosting with https, which phones need for Bluetooth).
# First run creates a PUBLIC repo called "obd-dash" and turns on Pages. Later runs push your changes.
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1
param([string]$RepoName = 'obd-dash', [string]$Message = 'Update OBD Dash')

$ErrorActionPreference = 'Continue'  # git/gh print progress on stderr; we check exit codes instead
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) is not installed: https://cli.github.com' }
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Run "gh auth login" first.' }

if (-not (Test-Path .git)) {
  git init -b main | Out-Null
}

git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -m $Message | Out-Null; Write-Output 'Committed changes.' }

$hasRemote = (git remote) -contains 'origin'
if (-not $hasRemote) {
  Write-Output "Creating public GitHub repo '$RepoName'..."
  gh repo create $RepoName --public --source . --remote origin --push
  if ($LASTEXITCODE -ne 0) { throw 'Creating the repo failed (does it already exist?).' }
  Write-Output 'Turning on GitHub Pages...'
  gh api -X POST 'repos/{owner}/{repo}/pages' -f 'source[branch]=main' -f 'source[path]=/' | Out-Null
} else {
  git push origin main
}

$login = (gh api user -q .login).ToLower()
Write-Output ''
Write-Output "Done. Your app will be live in about a minute at:"
Write-Output "  https://$login.github.io/$RepoName/"
