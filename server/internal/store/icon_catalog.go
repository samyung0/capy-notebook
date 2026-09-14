package store

import (
	"fmt"
	"hash/fnv"
	"regexp"
)

// IconIDPattern describes the frozen catalog in src/lib/icon-catalog.json.
const IconIDPattern = `^((slice|sprouts|notionists)-(0[1-9]|1[0-2])|critters-(0[1-9]|1[0-6])|avataaars-(0[1-9]|1[0-9]|2[0-4])|waves-(0[1-9]|1[01]))$`

var iconIDRE = regexp.MustCompile(IconIDPattern)

func ValidIconID(id string) bool { return iconIDRE.MatchString(id) }

func defaultAvatarIconID(userID string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(userID))
	return fmt.Sprintf("avataaars-%02d", h.Sum32()%24+1)
}
