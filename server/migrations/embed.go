// Package migrations embeds numbered SQL files and the local demo seed.
// Store.Migrate applies only NNNN_*.sql once. dev_seed.sql is loaded
// separately for development.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
