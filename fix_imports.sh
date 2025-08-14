#!/bin/bash
echo "Fixing Go imports..."
find . -name "*.go" -type f | while read -r file; do
    if [[ "$file" == *"/vendor/"* ]]; then
        continue
    fi
    sed -i 's|github.com/otedama/otedama|github.com/shizukutanaka/Otedama|g' "$file"
done
echo "Import paths fixed!"
sed -i '/replace github.com\/otedama\/otedama => ./d' go.mod
echo "Removed legacy replace directive from go.mod"
echo "Done!"