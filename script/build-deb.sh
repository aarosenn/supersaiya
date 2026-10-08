#!/usr/bin/env bash
set -euo pipefail

# Build script for OpenCode Debian / Ubuntu .deb package
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
PKG_DIR="${DIST_DIR}/deb-pkg"

VERSION=$(node -p "require('${ROOT_DIR}/packages/opencode/package.json').version || '1.18.35'")
ARCH="${1:-amd64}"
DEB_NAME="opencode_${VERSION}_${ARCH}.deb"

echo "=========================================="
echo " Building OpenCode Ubuntu / Debian Package"
echo " Version: ${VERSION}"
echo " Architecture: ${ARCH}"
echo "=========================================="

# Clean up previous builds
rm -rf "${PKG_DIR}"
mkdir -p "${PKG_DIR}/DEBIAN"
mkdir -p "${PKG_DIR}/usr/bin"
mkdir -p "${PKG_DIR}/usr/share/applications"
mkdir -p "${PKG_DIR}/usr/share/doc/opencode"
mkdir -p "${DIST_DIR}"

# 1. Compile binary if bun is present, or copy compiled output
if command -v bun >/dev/null 2>&1; then
    echo "[1/4] Compiling native binary using Bun..."
    bun build --compile --minify "${ROOT_DIR}/packages/opencode/src/index.ts" --outfile "${PKG_DIR}/usr/bin/opencode"
    chmod 755 "${PKG_DIR}/usr/bin/opencode"
elif [ -f "${DIST_DIR}/bin/opencode" ]; then
    echo "[1/4] Using precompiled binary from ${DIST_DIR}/bin/opencode..."
    cp "${DIST_DIR}/bin/opencode" "${PKG_DIR}/usr/bin/opencode"
    chmod 755 "${PKG_DIR}/usr/bin/opencode"
else
    echo "[!] Bun not found and no precompiled binary found. Please install Bun or compile first."
    exit 1
fi

# 2. Generate control file
echo "[2/4] Writing DEBIAN/control..."
cat <<EOF > "${PKG_DIR}/DEBIAN/control"
Package: opencode
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Maintainer: OpenCode Community <support@opencode.ai>
Homepage: https://github.com/anomalyco/opencode
Description: AI-Powered Development Tool & Google Antigravity Alternative
 Native Ubuntu / Debian package for OpenCode featuring:
  - Universal Model Provider Router (Google Gemini, OpenAI, Anthropic,
    DeepSeek, Groq, OpenRouter, Together AI, Ollama, LM Studio, Custom).
  - Flexible Model Context Protocol (MCP) profiles, granular permissions,
    and bulk toggles.
  - Skill System with auto-discovery, trigger keyword matching, and tool dependencies.
  - Complete Conversation Management (list, search, clear, export to Markdown/JSON).
EOF

# 3. Post-install script
echo "[3/4] Writing DEBIAN/postinst..."
cat << 'EOF' > "${PKG_DIR}/DEBIAN/postinst"
#!/bin/sh
set -e
chmod 755 /usr/bin/opencode
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q || true
fi
echo "✓ OpenCode installed successfully! Type 'opencode' to start."
exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/postinst"

# 4. Desktop entry
cat << 'EOF' > "${PKG_DIR}/usr/share/applications/opencode.desktop"
[Desktop Entry]
Name=OpenCode
Comment=AI-Powered Coding Agent & Pair Programmer
GenericName=AI Development Tool
Exec=/usr/bin/opencode
Icon=utilities-terminal
Terminal=true
Type=Application
Categories=Development;IDE;TextEditor;
Keywords=ai;code;assistant;antigravity;gemini;openai;claude;deepseek;
StartupNotify=true
EOF

# 5. Build .deb
echo "[4/4] Building .deb package with dpkg-deb..."
dpkg-deb --build --root-owner-group "${PKG_DIR}" "${DIST_DIR}/${DEB_NAME}"

echo "=========================================="
echo " Package successfully built!"
echo " Location: ${DIST_DIR}/${DEB_NAME}"
echo ""
echo " To install on Ubuntu / Debian:"
echo "   sudo dpkg -i ${DIST_DIR}/${DEB_NAME}"
echo "   sudo apt-get install -f  # (if any missing dependencies)"
echo "=========================================="
