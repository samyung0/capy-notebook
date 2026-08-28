package testdb

import "testing"

func TestValidateURL(t *testing.T) {
	tests := []struct {
		name   string
		marker string
		url    string
		ok     bool
	}{
		{name: "harness inactive", url: "postgres://evo:evo@127.0.0.1:5432/evo"},
		{name: "empty URL", marker: "1"},
		{name: "remote host", marker: "1", url: "postgres://evo:evo@db.example.com:5432/evo"},
		{name: "missing mapped port", marker: "1", url: "postgres://evo:evo@localhost/evo"},
		{name: "loopback IPv4", marker: "1", url: "postgres://evo:evo@127.0.0.1:49152/evo", ok: true},
		{name: "localhost", marker: "1", url: "postgresql://evo:evo@localhost:49152/evo", ok: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateURL(test.marker, test.url)
			if (err == nil) != test.ok {
				t.Fatalf("validateURL() = %v, want success=%v", err, test.ok)
			}
		})
	}
}
