package store

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var migrationFileName = regexp.MustCompile(`^(B?)([0-9]{4})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$`)

type migrationFile struct {
	name     string
	version  int
	baseline bool
	body     []byte
}
type migrationPlan struct {
	files      []migrationFile
	status     []MigrationFileStatus
	needsEmpty bool
}

func readMigrationFiles(fsys fs.FS) ([]migrationFile, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, err
	}
	var files []migrationFile
	seen := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		match := migrationFileName.FindStringSubmatch(name)
		if match == nil {
			if strings.HasSuffix(strings.ToLower(name), ".sql") && (name[0] >= '0' && name[0] <= '9' || name[0] == 'B' || name[0] == 'b') {
				return nil, fmt.Errorf("migrate: malformed migration filename %s", name)
			}
			continue
		}
		if entry.IsDir() {
			return nil, fmt.Errorf("migrate: migration is a directory: %s", name)
		}
		key := match[1] + match[2]
		if seen[key] {
			return nil, fmt.Errorf("migrate: duplicate migration version %s", key)
		}
		seen[key] = true
		version, _ := strconv.Atoi(match[2])
		if version == 0 {
			return nil, fmt.Errorf("migrate: zero migration version: %s", name)
		}
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, err
		}
		files = append(files, migrationFile{name, version, match[1] == "B", body})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].baseline != files[j].baseline {
			return files[i].baseline
		}
		return files[i].version < files[j].version
	})
	return files, nil
}

func planMigrations(fsys fs.FS, applied map[string]string) (migrationPlan, error) {
	files, err := readMigrationFiles(fsys)
	if err != nil {
		return migrationPlan{}, err
	}
	plan := migrationPlan{files: files}
	known := map[string]migrationFile{}
	forwards := map[int]migrationFile{}
	cutoff, maxKnown, maxApplied := 0, 0, 0
	selected := ""
	for _, file := range files {
		known[file.name] = file
		if !file.baseline {
			forwards[file.version] = file
			if file.version > maxKnown {
				maxKnown = file.version
			}
		}
	}
	for name, sum := range applied {
		match := migrationFileName.FindStringSubmatch(name)
		if match == nil {
			return plan, fmt.Errorf("migrate: unsupported ledger filename %s", name)
		}
		version, _ := strconv.Atoi(match[2])
		if version == 0 {
			return plan, fmt.Errorf("migrate: zero ledger version: %s", name)
		}
		file, ok := known[name]
		if ok && checksumSQL(file.body) != sum {
			return plan, fmt.Errorf("migrate: %s already applied with a different checksum; add a new numbered file", name)
		}
		if match[1] == "B" {
			if !ok || selected != "" {
				return plan, fmt.Errorf("migrate: unsupported or missing applied baseline %s", name)
			}
			selected = name
			cutoff = version
		} else if version > maxApplied {
			maxApplied = version
		}
	}
	if len(applied) == 0 {
		for _, file := range files {
			if file.baseline && file.version > cutoff {
				selected = file.name
				cutoff = file.version
			}
		}
		plan.needsEmpty = selected != ""
	}
	// Validate the entire active forward range before any write, including fresh databases.
	for version := cutoff + 1; version <= maxKnown; version++ {
		file, ok := forwards[version]
		if !ok {
			return plan, fmt.Errorf("migrate: missing numbered migration %04d through available version %04d", version, maxKnown)
		}
		if _, ok := applied[file.name]; !ok && version <= maxApplied {
			return plan, fmt.Errorf("migrate: unapplied older migration %s before applied version %04d", file.name, maxApplied)
		}
	}
	for _, file := range files {
		st := MigrationFileStatus{Filename: file.name, Checksum: checksumSQL(file.body), State: "pending"}
		if sum, ok := applied[file.name]; ok {
			st.Applied = true
			st.AppliedChecksum = sum
			st.State = "applied"
		} else if file.baseline && file.name != selected {
			st.State = "ignored-baseline"
		} else if !file.baseline && file.version <= cutoff {
			st.State = "covered-by-baseline"
		}
		plan.status = append(plan.status, st)
	}
	return plan, nil
}
