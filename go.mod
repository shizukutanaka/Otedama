module github.com/shizukutanaka/Otedama

go 1.21

require (
	// Core dependencies
	github.com/dgraph-io/ristretto v0.2.0
	github.com/gorilla/mux v1.8.1
	github.com/gorilla/websocket v1.5.1
	github.com/jaypipes/ghw v0.17.0
	github.com/prometheus/client_golang v1.17.0
	github.com/shirou/gopsutil/v3 v3.24.5
	github.com/spf13/viper v1.17.0
	github.com/stretchr/testify v1.9.0
	go.uber.org/zap v1.26.0
	golang.org/x/crypto v0.14.0
	golang.org/x/net v0.17.0
	golang.org/x/term v0.13.0
	golang.org/x/time v0.3.0
	gopkg.in/natefinch/lumberjack.v2 v2.2.1
	
	// Enhanced ZKP libraries (latest 2025 versions)
	github.com/consensys/gnark v0.10.0
	github.com/consensys/gnark-crypto v0.12.1
	github.com/prysmaticlabs/prysm/v4 v4.1.1
	github.com/ethereum/go-ethereum v1.13.5
	
	// Advanced mining and hardware optimization
	github.com/ebitengine/purego v0.5.0
	github.com/klauspost/cpuid/v2 v2.2.5
	github.com/intel-go/cpuid v0.3.0
	github.com/tidwall/gjson v1.17.0
	
	// Machine Learning and AI optimization
	github.com/gorgonia/gorgonia v0.9.17
	github.com/sajari/regression v1.0.1
	github.com/gonum/matrix/mat64 v0.0.0-20170622082636-e2a9bb3a9e82
	
	// Enterprise security and compliance
	github.com/hashicorp/vault/api v1.10.0
	github.com/go-sql-driver/mysql v1.7.1
	github.com/lib/pq v1.10.9
	github.com/go-redis/redis/v8 v8.11.5
	
	// Privacy and anonymity
	github.com/cretz/bine v0.2.0
	github.com/eyedeekay/sam3 v0.33.6
	
	// Performance optimization
	github.com/cespare/xxhash/v2 v2.2.0
	github.com/pierrec/lz4/v4 v4.1.18
	github.com/valyala/fasthttp v1.51.0
	github.com/tidwall/evio v1.0.8
	
	// Monitoring and observability
	github.com/grafana/grafana-api-golang-client v0.21.0
	github.com/influxdata/influxdb-client-go/v2 v2.12.3
	github.com/elastic/go-elasticsearch/v8 v8.11.0
	
	// Testing and benchmarking
	github.com/montanaflynn/stats v0.7.1
	github.com/pkg/profile v1.7.0
	
	// Advanced networking
	github.com/libp2p/go-libp2p v0.31.0
	github.com/multiformats/go-multiaddr v0.11.0
	
	// Cryptographic enhancements
	github.com/consensys/bavard v0.1.13
	github.com/consensys/gnark/std v0.3.0
	github.com/cloudflare/circl v1.3.6
)

require (
	github.com/StackExchange/wmi v1.2.1 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/fsnotify/fsnotify v1.7.0 // indirect
	github.com/go-ole/go-ole v1.2.6 // indirect
	github.com/golang/protobuf v1.5.3 // indirect
	github.com/hashicorp/hcl v1.0.0 // indirect
	github.com/jaypipes/pcidb v1.0.1 // indirect
	github.com/lufia/plan9stats v0.0.0-20211012122336-39d0f177ccd0 // indirect
	github.com/magiconair/properties v1.8.7 // indirect
	github.com/matttproud/golang_protobuf_extensions v1.0.4 // indirect
	github.com/mitchellh/go-homedir v1.1.0 // indirect
	github.com/mitchellh/mapstructure v1.5.0 // indirect
	github.com/pelletier/go-toml/v2 v2.1.0 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/power-devops/perfstat v0.0.0-20210106213030-5aafc221ea8c // indirect
	github.com/prometheus/client_model v0.4.1-0.20230718164431-9a2bf3000d16 // indirect
	github.com/prometheus/common v0.44.0 // indirect
	github.com/prometheus/procfs v0.11.1 // indirect
	github.com/sagikazarmark/locafero v0.3.0 // indirect
	github.com/sagikazarmark/slog-shim v0.1.0 // indirect
	github.com/shoenig/go-m1cpu v0.1.6 // indirect
	github.com/sourcegraph/conc v0.3.0 // indirect
	github.com/spf13/afero v1.10.0 // indirect
	github.com/spf13/cast v1.5.1 // indirect
	github.com/spf13/pflag v1.0.5 // indirect
	github.com/subosito/gotenv v1.6.0 // indirect
	github.com/tklauser/go-sysconf v0.3.12 // indirect
	github.com/tklauser/numcpus v0.6.1 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	golang.org/x/exp v0.0.0-20230905200255-921286631fa9 // indirect
	golang.org/x/sys v0.20.0 // indirect
	golang.org/x/text v0.14.0 // indirect
	google.golang.org/protobuf v1.31.0 // indirect
	gopkg.in/ini.v1 v1.67.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	howett.net/plist v1.0.0 // indirect
)
