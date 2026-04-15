# install.ps1 -- Atelier Windows installer
# Usage: .\install.ps1
# Prerequisites: Bun (https://bun.sh), Git

$ErrorActionPreference = "Stop"

function Write-Info($msg)  { Write-Host "> $msg" -ForegroundColor Blue }
function Write-Ok($msg)    { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "Error: $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Info "Atelier Installer"
Write-Host "  Autonomous coding orchestration system"
Write-Host ""

# Check prerequisites
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Err "bun is required (https://bun.sh)"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "git is required"
}

# Install dependencies
Write-Info "Installing dependencies..."
bun install
if ($LASTEXITCODE -ne 0) { Write-Err "bun install failed" }
Write-Ok "Dependencies installed"

# Build
Write-Info "Building Atelier..."
bun run build
if ($LASTEXITCODE -ne 0) { Write-Err "Build failed" }
Write-Ok "Build complete"

# Strobe not available on Windows
Write-Warn "Strobe is not available on Windows -- skipping installation"

# MCP config
if ((-not (Test-Path ".mcp.json")) -and (Test-Path ".mcp.json.example")) {
    Write-Info "Creating .mcp.json from .mcp.json.example..."
    Copy-Item ".mcp.json.example" ".mcp.json"
    Write-Ok "MCP config created"
} else {
    Write-Ok "MCP config already exists"
}

Write-Host ""
Write-Ok "Atelier installed!"
Write-Host ""
Write-Host "  Open VS Code and press Ctrl+Shift+A to start."
Write-Host ""
Write-Host "  You will need at least one backend:"
Write-Host "    Claude Code: npm install -g @anthropic-ai/claude-code && claude login"
Write-Host "    OpenCode:    See https://github.com/opencode-ai/opencode"
Write-Host ""
