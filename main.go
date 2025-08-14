//go:build ignore
 
 // Legacy/ignored: excluded from production builds. Use cmd/otedama/entrypoint.go.
 package main
 
 import (
     "github.com/shizukutanaka/Otedama/cmd/otedama/commands"
 )
 
 func main() {
     commands.Execute()
 }
