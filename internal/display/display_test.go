// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package display

import "testing"

func TestMaskAddress(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"", ""},
		{"abc", "abc"},
		{"1234567890", "1234567890"},     // boundary: 10 chars, unchanged
		{"12345678901", "123456···8901"}, // boundary: 11 chars, masked
		{"123456789012", "123456···9012"},
		{"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bc1qar···5mdq"},
	}
	for _, tt := range tests {
		if got := MaskAddress(tt.in); got != tt.want {
			t.Errorf("MaskAddress(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
