package app

import (
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type guideUnavailableError struct{}

func (guideUnavailableError) Error() string {
	return "provider returned no usable future programme guide"
}

func usableGuide(programs []model.Program, now time.Time) []model.Program {
	valid := make([]model.Program, 0, len(programs))
	hasFuture := false
	for _, program := range programs {
		if program.ChannelID == "" || program.Start.IsZero() || !program.End.After(program.Start) {
			continue
		}
		valid = append(valid, program)
		hasFuture = hasFuture || program.End.After(now)
	}
	if !hasFuture {
		return nil
	}
	return valid
}
