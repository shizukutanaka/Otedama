#!/bin/bash
echo "Fixing Go imports..."
find . -name "*.go" -type f | while read -r file; do
    if [[ "$file" == *"/vendor/"* ]]; then
        continue
    fi
    sed -i 's|github.com/shizukutanaka/Otedama|github.com/otedama/otedama|g' "$file"
done
echo "Import paths fixed!"
sed -i '/replace github.com\/shizukutanaka\/Otedama => ./d' go.mod
echo "Removed legacy replace directive from go.mod"
echo "Done!"