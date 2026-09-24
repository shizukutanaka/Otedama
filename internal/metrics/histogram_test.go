// SPDX-License-Identifier: Apache-2.0
package metrics

import (
	"strings"
	"testing"
)

func TestHistogram_BucketsAndExemplar(t *testing.T) {
	reg := NewRegistry()
	h := reg.NewHistogram("test_seconds", "d", nil, []float64{0.1, 0.5, 1})
	h.Observe(0.05)
	h.ObserveWithExemplar(0.3, map[string]string{"share_seq": "7"})
	h.ObserveWithExemplar(0.9, map[string]string{"share_seq": "9"})
	var sb strings.Builder
	if err := reg.WriteText(&sb); err != nil {
		t.Fatal(err)
	}
	out := sb.String()
	for _, want := range []string{
		"# HELP test_seconds d",
		"# TYPE test_seconds histogram",
		`test_seconds_bucket{le="0.1"} 1`,
		`test_seconds_bucket{le="0.5"} 2 # {share_seq="7"} 0.3`,
		`test_seconds_bucket{le="1"} 3 # {share_seq="9"} 0.9`,
		`test_seconds_bucket{le="+Inf"} 3`,
		"test_seconds_sum 1.25",
		"test_seconds_count 3",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestHistogram_Labels(t *testing.T) {
	reg := NewRegistry()
	h := reg.NewHistogram("test_seconds", "d", map[string]string{"pool": "a"}, []float64{1})
	h.Observe(0.5)
	var sb strings.Builder
	reg.WriteText(&sb) //nolint:errcheck
	out := sb.String()
	if !strings.Contains(out, `test_seconds_bucket{pool="a",le="1"} 1`) {
		t.Errorf("family labels missing on bucket:\n%s", out)
	}
	if !strings.Contains(out, `test_seconds_sum{pool="a"} 0.5`) {
		t.Errorf("family labels missing on sum:\n%s", out)
	}
}

func TestHistogram_NoExemplarWhenPlainObserve(t *testing.T) {
	reg := NewRegistry()
	h := reg.NewHistogram("test_seconds", "d", nil, []float64{1})
	h.Observe(0.5)
	var sb strings.Builder
	reg.WriteText(&sb) //nolint:errcheck
	if strings.Contains(sb.String(), "# {") {
		t.Errorf("plain Observe must not emit exemplars:\n%s", sb.String())
	}
}

func TestHistogram_BadExemplarLabelsDropped(t *testing.T) {
	reg := NewRegistry()
	h := reg.NewHistogram("test_seconds", "d", nil, []float64{1})
	h.ObserveWithExemplar(0.5, map[string]string{"bad-name": "x"})
	h.ObserveWithExemplar(0.5, map[string]string{"ok": strings.Repeat("v", 200)})
	var sb strings.Builder
	reg.WriteText(&sb) //nolint:errcheck
	out := sb.String()
	if strings.Contains(out, "# {") {
		t.Errorf("invalid/oversized exemplar labels must drop:\n%s", out)
	}
	if !strings.Contains(out, "test_seconds_count 2") {
		t.Errorf("observations still counted:\n%s", out)
	}
}

func TestHistogram_DuplicateRegistration(t *testing.T) {
	reg := NewRegistry()
	a := reg.NewHistogram("test_seconds", "d", nil, []float64{1})
	b := reg.NewHistogram("test_seconds", "d", nil, []float64{1})
	if a != b {
		t.Fatal("same name+labels must return the same histogram")
	}
}

func TestHistogram_TypeCollisionPanics(t *testing.T) {
	reg := NewRegistry()
	reg.NewGauge("shared", "d", nil)
	defer func() {
		if recover() == nil {
			t.Fatal("histogram on a gauge name must panic")
		}
	}()
	reg.NewHistogram("shared", "d", nil, []float64{1})
}

func TestHistogram_GaugeOnHistogramNamePanics(t *testing.T) {
	reg := NewRegistry()
	reg.NewHistogram("shared", "d", nil, []float64{1})
	defer func() {
		if recover() == nil {
			t.Fatal("gauge on a histogram name must panic")
		}
	}()
	reg.NewGauge("shared", "d", nil)
}

func TestHistogram_UnsortedBoundsPanic(t *testing.T) {
	reg := NewRegistry()
	defer func() {
		if recover() == nil {
			t.Fatal("unsorted bounds must panic")
		}
	}()
	reg.NewHistogram("test_seconds", "d", nil, []float64{1, 0.5})
}
