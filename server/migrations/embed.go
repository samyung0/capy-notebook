// Package migrations embeds numbered SQL files, optional baseline snapshots, and the local demo seed.
// Store.Migrate applies NNNN_*.sql and selects BNNNN_*.sql only for a fresh database. dev_seed.sql is loaded
// separately for development.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
