// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package metrics

import (
	"fmt"
	"io"
	"runtime"
)

// RuntimeCollector returns a CollectFunc that writes standard go_* metrics
// derived from the Go runtime. Register it once via Registry.RegisterCollector.
//
// The metric names match the ones emitted by prometheus/client_golang so that
// existing Grafana dashboards work without modification. Not all names are
// replicated: go_gc_duration_seconds is normally a summary type; since this
// package does not implement summaries, the aggregate cost is exposed instead
// as go_gc_duration_seconds_total (counter, total pause time in seconds) and
// go_gc_cycles_total (counter, completed GC cycles). PromQL rate() queries on
// those two counters are the most common dashboard use.
//
// Metrics emitted:
//
//	go_goroutines                         gauge   number of existing goroutines
//	go_info{version="go1.x.y"}            gauge   (value 1) build identity
//	go_memstats_alloc_bytes               gauge   bytes allocated and in use
//	go_memstats_sys_bytes                 gauge   bytes obtained from OS
//	go_memstats_heap_alloc_bytes          gauge   heap bytes allocated and in use
//	go_memstats_heap_sys_bytes            gauge   heap bytes from OS
//	go_memstats_heap_inuse_bytes          gauge   heap bytes in use by live objects
//	go_memstats_heap_idle_bytes           gauge   heap bytes waiting to be used
//	go_memstats_stack_inuse_bytes         gauge   bytes in use by stack allocator
//	go_memstats_gc_cpu_fraction           gauge   GC CPU fraction of available CPU
//	go_gc_duration_seconds_total          counter total GC stop-the-world pause seconds
//	go_gc_cycles_total                    counter total completed GC cycles
func RuntimeCollector() CollectFunc {
	goVer := runtime.Version()
	return func(w io.Writer) error {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		goroutines := runtime.NumGoroutine()

		type mentry struct {
			name   string
			help   string
			kind   string
			labels string // pre-rendered label set including braces, or ""
			value  string
		}
		entries := []mentry{
			{
				name:  "go_goroutines",
				help:  "Number of goroutines that currently exist.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", goroutines),
			},
			{
				name:   "go_info",
				help:   "Information about the Go environment.",
				kind:   "gauge",
				labels: fmt.Sprintf(`{version="%s"}`, escapeLabel(goVer)),
				value:  "1",
			},
			{
				name:  "go_memstats_alloc_bytes",
				help:  "Number of bytes allocated and still in use.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", ms.Alloc),
			},
			{
				name:  "go_memstats_sys_bytes",
				help:  "Number of bytes obtained from the OS.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", ms.Sys),
			},
			{
				name:  "go_memstats_heap_alloc_bytes",
				help:  "Number of heap bytes allocated and still in use.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", ms.HeapAlloc),
			},
			{
				name:  "go_memstats_heap_sys_bytes",
				help:  "Number of heap bytes obtained from the OS.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", ms.HeapSys),
			},
			{
				name:  "go_memstats_heap_inuse_bytes",
				help:  "Number of heap bytes in use by live objects.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", ms.HeapInuse),
			},
			{
				name:  "go_memstats_heap_idle_bytes",
				help:  "Number of heap bytes waiting to be used.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", ms.HeapIdle),
			},
			{
				name:  "go_memstats_stack_inuse_bytes",
				help:  "Number of bytes in use by the stack allocator.",
				kind:  "gauge",
				value: fmt.Sprintf("%d", ms.StackInuse),
			},
			{
				name:  "go_memstats_gc_cpu_fraction",
				help:  "The fraction of this program's available CPU time used by GC since the program started.",
				kind:  "gauge",
				value: fmt.Sprintf("%g", ms.GCCPUFraction),
			},
			{
				name:  "go_gc_duration_seconds_total",
				help:  "Total time spent in GC stop-the-world pauses, in seconds.",
				kind:  "counter",
				value: fmt.Sprintf("%g", float64(ms.PauseTotalNs)/1e9),
			},
			{
				name:  "go_gc_cycles_total",
				help:  "Total number of completed GC cycles.",
				kind:  "counter",
				value: fmt.Sprintf("%d", ms.NumGC),
			},
		}
		for _, e := range entries {
			if _, err := fmt.Fprintf(w,
				"# HELP %s %s\n# TYPE %s %s\n%s%s %s\n",
				e.name, e.help,
				e.name, e.kind,
				e.name, e.labels, e.value,
			); err != nil {
				return err
			}
		}
		return nil
	}
}
