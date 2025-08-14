package commands

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)



var (
	cfgFile string
	verbose bool
)

// rootCmd represents the base command
var rootCmd = &cobra.Command{
	Use:   "otedama",
	Short: "High-Performance P2P Mining Pool Software",
	Long: `Otedama is a professional-grade cryptocurrency mining software designed for 
reliable operations with support for CPU, GPU, and ASIC mining. Built with 
advanced authentication mechanisms including Zero-Knowledge Proof (ZKP), it 
provides secure and efficient mining capabilities suitable for enterprise deployments.`,
}

// Execute adds all child commands to the root command and sets flags appropriately.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	cobra.OnInitialize(initConfig)

	// Global flags
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is ./config.yaml)")
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "verbose output")

	// Add commands
	rootCmd.AddCommand(initCmd)
	rootCmd.AddCommand(startCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(soloCmd)
	rootCmd.AddCommand(poolCmd)
	rootCmd.AddCommand(p2pCmd)
	rootCmd.AddCommand(benchmarkCmd)

	// Version output disabled per project guidelines (no version notation).
}

func initConfig() {
	// Config initialization will be handled by individual commands
}