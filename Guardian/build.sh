#!/bin/bash
# AG Guardian 打包脚本
# 构建二进制并打包为 macOS .app

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="AG Guardian"
BUNDLE_ID="com.ag-recover.guardian"
BUILD_DIR=".build/release"
APP_DIR="$SCRIPT_DIR/$APP_NAME.app"

echo "🔨 Building..."
swift build -c release 2>&1 | grep -E "(Build|error|warning:.*error)" || true

# 检查编译结果
BINARY="$BUILD_DIR/AGGuardian"
if [ ! -f "$BINARY" ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "📦 Packaging $APP_NAME.app..."

# 清理旧的
rm -rf "$APP_DIR"

# 创建 .app 结构
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# 复制二进制
cp "$BINARY" "$APP_DIR/Contents/MacOS/AGGuardian"

# 写 Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>AG Guardian</string>
    <key>CFBundleIdentifier</key>
    <string>com.ag-recover.guardian</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleExecutable</key>
    <string>AGGuardian</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

echo "✅ $APP_NAME.app 已生成"
echo ""
echo "运行方式:"
echo "  open \"$APP_DIR\""
echo ""
echo "安装到 Applications:"
echo "  cp -r \"$APP_DIR\" /Applications/"
