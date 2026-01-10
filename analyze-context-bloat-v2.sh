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

# Check if we're in a project directory (monorepo structure)
if [ ! -f "backend/package.json" ] && [ ! -f "frontend/package.json" ] && [ ! -f "package.json" ]; then
    echo "❌ Error: Run this script from your Lidify project root directory"
    echo "   (Looking for backend/package.json or frontend/package.json or package.json)"
    exit 1
fi

echo "✅ Found project structure (monorepo detected)"
echo ""

echo "📊 TOP 30 LARGEST FILES (excluding node_modules):"
echo "=============================================================================="
find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -not -path "*/dist/*" -exec du -h {} + 2>/dev/null | sort -rh | head -30
echo ""

echo "📦 DIRECTORY SIZES (top-level):"
echo "=============================================================================="
du -h --max-depth=1 . 2>/dev/null | sort -rh
echo ""

echo "📦 SUBDIRECTORY SIZES (backend, frontend, services):"
echo "=============================================================================="
for dir in backend frontend services scripts; do
    if [ -d "$dir" ]; then
        echo ""
        echo "--- $dir/ ---"
        du -h --max-depth=2 "$dir" 2>/dev/null | sort -rh | head -10
    fi
done
echo ""

echo "🖼️  IMAGE FILES (all types):"
echo "=============================================================================="
find . -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.gif" -o -name "*.webp" -o -name "*.svg" -o -name "*.ico" \) -not -path "*/node_modules/*" 2>/dev/null | wc -l
echo "Total image files found"
echo ""
echo "Largest images:"
find . -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.gif" -o -name "*.webp" \) -not -path "*/node_modules/*" -exec du -h {} + 2>/dev/null | sort -rh | head -20
echo ""

echo "📝 LOCK FILES & GENERATED CODE:"
echo "=============================================================================="
find . -type f \( -name "package-lock.json" -o -name "yarn.lock" -o -name "pnpm-lock.yaml" -o -name "*.tsbuildinfo" \) -exec du -h {} \; 2>/dev/null
echo ""

echo "📜 MIGRATION FILES:"
echo "=============================================================================="
if [ -d "backend/prisma/migrations" ]; then
    echo "Total migration directory size:"
    du -sh backend/prisma/migrations 2>/dev/null
    echo ""
    echo "Number of migrations:"
    ls -1 backend/prisma/migrations 2>/dev/null | wc -l
    echo ""
    echo "Oldest migrations (first 10):"
    ls -1 backend/prisma/migrations 2>/dev/null | head -10
    echo ""
    echo "Newest migrations (last 5):"
    ls -1 backend/prisma/migrations 2>/dev/null | tail -5
else
    echo "No migrations directory found"
fi
echo ""

echo "🗂️  FILE TYPE BREAKDOWN:"
echo "=============================================================================="
echo "TypeScript/JavaScript files:"
find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \) -not -path "*/node_modules/*" -not -path "*/.next/*" 2>/dev/null | wc -l
echo ""
echo "JSON files:"
find . -type f -name "*.json" -not -path "*/node_modules/*" 2>/dev/null | wc -l
echo ""
echo "CSS/Style files:"
find . -type f \( -name "*.css" -o -name "*.scss" -o -name "*.sass" \) -not -path "*/node_modules/*" 2>/dev/null | wc -l
echo ""
echo "Markdown files:"
find . -type f -name "*.md" 2>/dev/null | wc -l
echo ""

echo "💾 ESTIMATED TOKEN COUNT:"
echo "=============================================================================="
# Rough estimation: 1 token ≈ 4 characters
total_chars=$(find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.json" -o -name "*.md" -o -name "*.css" -o -name "*.yml" -o -name "*.yaml" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -not -path "*/dist/*" -exec cat {} \; 2>/dev/null | wc -c)
estimated_tokens=$((total_chars / 4))

if [ $estimated_tokens -gt 0 ]; then
    echo "Total characters in text files: $(printf "%'d" $total_chars)"
    echo "Estimated current token count: ~$(printf "%'d" $estimated_tokens) tokens"
    echo ""
    
    optimized_tokens=$((estimated_tokens * 40 / 100))
    echo "Estimated AFTER .rooignore: ~$(printf "%'d" $optimized_tokens) tokens (60% reduction)"
else
    echo "Could not calculate token estimate"
fi
echo ""

echo "🎯 LARGE FILES ANALYSIS:"
echo "=============================================================================="

echo "Large JSON files (>50KB):"
large_json=$(find . -type f -name "*.json" -not -path "*/node_modules/*" -not -name "package.json" -not -name "tsconfig.json" -size +50k 2>/dev/null)
if [ -n "$large_json" ]; then
    echo "$large_json" | while read file; do
        size=$(du -h "$file" | cut -f1)
        echo "  $size - $file"
    done
else
    echo "  None found"
fi
echo ""

echo "Large CSS files (>30KB):"
large_css=$(find . -type f \( -name "*.css" -o -name "*.scss" \) -not -path "*/node_modules/*" -size +30k 2>/dev/null)
if [ -n "$large_css" ]; then
    echo "$large_css" | while read file; do
        size=$(du -h "$file" | cut -f1)
        echo "  $size - $file"
    done
else
    echo "  None found"
fi
echo ""

echo "Test files:"
test_count=$(find . -type f \( -name "*.test.*" -o -name "*.spec.*" \) -not -path "*/node_modules/*" 2>/dev/null | wc -l)
echo "  Found $test_count test files"
if [ "$test_count" -gt 0 ]; then
    echo "  Consider excluding with: *.test.* and *.spec.*"
fi
echo ""

python_files=$(find . -type f -name "*.py" -not -path "*/node_modules/*" 2>/dev/null | wc -l)
if [ "$python_files" -gt 0 ]; then
    echo "Python files (services):"
    echo "  Found $python_files Python files"
    echo "  Largest Python files:"
    find . -type f -name "*.py" -not -path "*/node_modules/*" -exec du -h {} + 2>/dev/null | sort -rh | head -5
    echo ""
fi

docker_files=$(find . -maxdepth 2 -type f \( -name "Dockerfile*" -o -name "docker-compose*.yml" \) 2>/dev/null | wc -l)
if [ "$docker_files" -gt 0 ]; then
    echo "Docker configuration files:"
    find . -maxdepth 2 -type f \( -name "Dockerfile*" -o -name "docker-compose*.yml" \) -exec du -h {} \; 2>/dev/null
    echo ""
fi

echo "=============================================================================="
echo "🎯 RECOMMENDED .rooignore ADDITIONS:"
echo "=============================================================================="
echo ""
echo "Based on this analysis, your .rooignore should definitely include:"
echo ""
echo "1. node_modules/ (if exists)"
echo "2. Lock files (package-lock.json, yarn.lock)"
echo "3. All images in assets/screenshots/"
echo "4. Build artifacts (.next/, dist/, build/)"
echo "5. Old migrations (backend/prisma/migrations/2024*/)"
echo ""

if [ -n "$large_json" ]; then
    echo "6. Large JSON files:"
    echo "$large_json" | while read file; do
        echo "   $file"
    done
    echo ""
fi

if [ "$test_count" -gt 5 ]; then
    echo "7. Test files (*.test.*, *.spec.*)"
    echo ""
fi

echo "=============================================================================="
echo "✅ Analysis complete!"
echo ""
echo "Next steps:"
echo "1. Share this output with Claude"
echo "2. Claude will create a custom .rooignore for your project"
echo "3. Copy .rooignore to project root"
echo "4. Make a Roo Code request and verify token reduction"
echo "=============================================================================="
