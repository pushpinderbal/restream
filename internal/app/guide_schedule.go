package app

import (
	"sort"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

// Measure the earliest contiguous coverage end among channels with future
// guide data. Individual missing/expired-only channels do not pull a usable
// guide's schedule forward; an entirely unavailable guide needs an early retry.
func guideCoverageEnd(programs []model.Program, at time.Time) time.Time {
	channels := make(map[string][]model.Program)
	for _, program := range programs {
		if program.End.After(at) && program.End.After(program.Start) {
			channels[program.ChannelID] = append(channels[program.ChannelID], program)
		}
	}
	var earliest time.Time
	for _, schedule := range channels {
		sort.Slice(schedule, func(i, j int) bool { return schedule[i].Start.Before(schedule[j].Start) })
		end := at
		for _, program := range schedule {
			// Portals can round adjacent programme boundaries differently.
			if program.Start.After(end.Add(time.Minute)) {
				break
			}
			if program.End.After(end) {
				end = program.End
			}
		}
		if earliest.IsZero() || end.Before(earliest) {
			earliest = end
		}
	}
	if earliest.IsZero() {
		return at
	}
	return earliest
}

type guideUnavailableError struct{}

func (guideUnavailableError) Error() string {
	return "provider returned no usable future programme guide"
}
func (guideUnavailableError) RetryDelay() time.Duration { return guideMinimumRefreshInterval }

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
