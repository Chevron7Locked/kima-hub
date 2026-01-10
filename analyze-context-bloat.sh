#!/bin/bash

# ==============================================================================
# analyze-context-bloat.sh
# ==============================================================================
# Purpose: Find large files in your project that are bloating Roo Code context
# Usage: Run this in your Lidify project root directory
#        chmod +x analyze-context-bloat.sh && ./analyze-context-bloat.sh
# ==============================================================================

echo "=============================================================================="
echo "Lidify Context Bloat Analysis"
echo "=============================================================================="
echo ""
echo "Analyzing your project to find files that should be excluded from Roo Code..."
echo ""

# Check if we're in a project directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Run this script from your Lidify project root directory"
    exit 1
fi

echo "📊 TOP 20 LARGEST FILES (excluding node_modules):"
echo "=============================================================================="
find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -exec du -h {} + 2>/dev/null | sort -rh | head -20
echo ""

echo "📦 DIRECTORY SIZES (excluding node_modules):"
echo "=============================================================================="
du -h --max-depth=2 . 2>/dev/null | grep -v node_modules | sort -rh | head -20
echo ""

echo "🖼️  IMAGE FILES TAKING UP SPACE:"
echo "=============================================================================="
find . -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.gif" -o -name "*.webp" \) -not -path "*/node_modules/*" -exec du -h {} + 2>/dev/null | sort -rh | head -20
echo ""

echo "📝 LOCK FILES & GENERATED CODE:"
echo "=============================================================================="
find . -type f \( -name "package-lock.json" -o -name "yarn.lock" -o -name "pnpm-lock.yaml" -o -name "*.tsbuildinfo" \) -exec du -h {} \;
echo ""

echo "📜 MIGRATION FILES:"
echo "=============================================================================="
if [ -d "backend/prisma/migrations" ]; then
    echo "Total migration directory size:"
    du -sh backend/prisma/migrations
    echo ""
    echo "Number of migrations:"
    ls -1 backend/prisma/migrations | wc -l
    echo ""
    echo "Oldest migrations (first 5):"
    ls -1 backend/prisma/migrations | head -5
    echo ""
    echo "Newest migrations (last 5):"
    ls -1 backend/prisma/migrations | tail -5
else
    echo "No migrations directory found"
fi
echo ""

echo "💾 ESTIMATED TOKEN COUNT:"
echo "=============================================================================="
# Rough estimation: 1 token ≈ 4 characters
total_chars=$(find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.json" -o -name "*.md" 2>/dev/null | xargs cat 2>/dev/null | wc -c)
estimated_tokens=$((total_chars / 4))
echo "Estimated current token count: ~$(printf "%'d" $estimated_tokens) tokens"
echo ""

echo "🎯 RECOMMENDED .rooignore ADDITIONS:"
echo "=============================================================================="
echo "Based on this analysis, consider adding these to .rooignore:"
echo ""

# Find large JSON files
large_json=$(find . -type f -name "*.json" -not -path "*/node_modules/*" -not -name "package.json" -not -name "tsconfig.json" -size +100k -exec du -h {} \; 2>/dev/null)
if [ -n "$large_json" ]; then
    echo "Large JSON files (>100KB):"
    echo "$large_json"
    echo ""
fi

# Find CSS/SCSS files if they're large
large_css=$(find . -type f \( -name "*.css" -o -name "*.scss" \) -not -path "*/node_modules/*" -size +50k -exec du -h {} \; 2>/dev/null)
if [ -n "$large_css" ]; then
    echo "Large CSS files (>50KB):"
    echo "$large_css"
    echo ""
fi

# Find test files
test_files=$(find . -type f \( -name "*.test.*" -o -name "*.spec.*" \) -not -path "*/node_modules/*" | wc -l)
if [ "$test_files" -gt 0 ]; then
    echo "Found $test_files test files - consider excluding with: *.test.* and *.spec.*"
    echo ""
fi

echo "=============================================================================="
echo "✅ Analysis complete!"
echo ""
echo "Next steps:"
echo "1. Copy .rooignore to your project root"
echo "2. Add any large files shown above to .rooignore"
echo "3. Make a Roo Code request and check token count in OpenRouter"
echo "4. Target: 60-80K tokens (down from 177K)"
echo "=============================================================================="
