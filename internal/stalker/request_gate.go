package stalker

import (
	"context"
	"sync"
)

type playbackRequestKey struct{}

// A single admitted request owns the portal session and pacing state. Playback
// gets the next turn ahead of waiting catalogue/guide work, without interrupting
// the current request or bypassing its cooldown.
type requestGate struct {
	mu              sync.Mutex
	held            bool
	playbackWaiters int
	changed         chan struct{}
}

func newRequestGate() *requestGate { return &requestGate{changed: make(chan struct{})} }

func (g *requestGate) acquire(ctx context.Context) error {
	priority, _ := ctx.Value(playbackRequestKey{}).(bool)
	g.mu.Lock()
	if priority {
		g.playbackWaiters++
	}
	defer func() {
		if priority {
			g.playbackWaiters--
		}
		if !g.held {
			g.notify()
		}
		g.mu.Unlock()
	}()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !g.held && (priority || g.playbackWaiters == 0) {
			g.held = true
			return nil
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-changed:
		}
		g.mu.Lock()
	}
}

func (g *requestGate) release() {
	g.mu.Lock()
	g.held = false
	g.notify()
	g.mu.Unlock()
}

// Caller holds mu.
func (g *requestGate) notify() {
	close(g.changed)
	g.changed = make(chan struct{})
}
