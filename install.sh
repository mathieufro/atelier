#!/usr/bin/env bash
set -euo pipefail

# Atelier installer — builds the project, installs dependencies, sets up tooling.
#
# Usage:
#   ./install.sh              # Full install (including Strobe)
#   ./install.sh --no-strobe  # Skip Strobe installation
#   ./install.sh --help       # Show usage
#
# Prerequisites: Bun (https://bun.sh), Git
# Optional: Rust toolchain (for Strobe — installed automatically if missing)

SKIP_STROBE=false

info()  { printf '\033[0;34m> %s\033[0m\n' "$*"; }
ok()    { printf '\033[0;32m  %s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m  %s\033[0m\n' "$*"; }
error() { printf '\033[0;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

show_help() {
    echo "Atelier Installer"
    echo ""
    echo "Usage: ./install.sh [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --no-strobe  Skip Strobe installation (LLM debugging tool)"
    echo "  --help       Show this help message"
    echo ""
    echo "What this script does:"
    echo "  1. Installs npm dependencies via Bun"
    echo "  2. Builds all packages (core, UI, CSS, extension)"
    echo "  3. Packages and installs the VS Code extension"
    echo "  4. Installs Strobe (requires Rust — will install rustup if missing)"
    echo "  5. Creates .mcp.json from .mcp.json.example"
    echo ""
    echo "Prerequisites: Bun (https://bun.sh), Git"
    exit 0
}

parse_args() {
    for arg in "$@"; do
        case "$arg" in
            --no-strobe) SKIP_STROBE=true ;;
            --help|-h) show_help ;;
            *) error "Unknown option: $arg (use --help for usage)" ;;
        esac
    done
}

check_deps() {
    command -v bun >/dev/null 2>&1 || error "bun is required (https://bun.sh)"
    command -v git >/dev/null 2>&1 || error "git is required"
}

install_deps() {
    info "Installing dependencies..."
    bun install
    ok "Dependencies installed"
}

build_project() {
    info "Building Atelier..."
    bun run build
    ok "Build complete"
}

install_strobe() {
    if [ "$SKIP_STROBE" = true ]; then
        warn "Skipping Strobe installation (--no-strobe)"
        return
    fi

    if command -v strobe >/dev/null 2>&1; then
        ok "Strobe already installed ($(strobe --version 2>/dev/null || echo 'unknown version'))"
        return
    fi

    echo ""
    warn "Strobe installation requires the Rust toolchain."
    warn "If Rust is not installed, rustup will be installed automatically."
    warn "To skip, re-run with: ./install.sh --no-strobe"
    echo ""

    info "Installing Strobe (LLM-native debugging infrastructure)..."

    # Check Rust toolchain (required by Strobe)
    if ! command -v cargo >/dev/null 2>&1; then
        warn "Rust toolchain not found. Installing via rustup..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        source "$HOME/.cargo/env"
    fi

    curl -fsSL https://raw.githubusercontent.com/mathieufro/strobe/main/install.sh | bash
    ok "Strobe installed"
}

setup_mcp() {
    if [ ! -f .mcp.json ] && [ -f .mcp.json.example ]; then
        info "Creating .mcp.json from .mcp.json.example..."
        cp .mcp.json.example .mcp.json
        ok "MCP config created"
    else
        ok "MCP config already exists"
    fi
}

main() {
    parse_args "$@"

    echo
    info "Atelier Installer"
    echo "  Autonomous coding orchestration system"
    echo

    check_deps
    install_deps
    build_project
    install_strobe
    setup_mcp

    echo
    ok "Atelier installed!"
    echo
    echo "  Open VS Code and press Cmd+Shift+A to start."
    echo
    echo "  You'll need at least one backend:"
    echo "    Claude Code: npm install -g @anthropic-ai/claude-code && claude login"
    echo "    OpenCode:    See https://github.com/opencode-ai/opencode"
    echo
}

main "$@"
