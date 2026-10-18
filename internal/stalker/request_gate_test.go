package stalker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func waitForPlaybackWaiter(t *testing.T, gate *requestGate) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gate.mu.Lock()
		waiting := gate.playbackWaiters
		gate.mu.Unlock()
		if waiting > 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("playback did not wait for request admission")
}

func TestPlaybackTakesNextProviderTurnWithoutBypassingPacing(t *testing.T) {
	firstStarted := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var mu sync.Mutex
	var actions []string
	var starts []time.Time
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		action := r.URL.Query().Get("action")
		mu.Lock()
		actions = append(actions, action)
		starts = append(starts, time.Now())
		mu.Unlock()
		if action == "active" {
			close(firstStarted)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if action == "create_link" {
			_, _ = w.Write([]byte(`{"js":{"cmd":"http://media.invalid/video.ts"}}`))
		} else {
			_, _ = w.Write([]byte(`{"js":[]}`))
		}
	}))
	defer portal.Close()
	c, err := New(Config{PortalURL: portal.URL + "/portal.php", MAC: "00:11:22:33:44:55", RequestInterval: 80 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	c.token = "ready"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	results := make(chan error, 4)
	go func() { _, err := c.request(ctx, "vod", "active", url.Values{}); results <- err }()
	select {
	case <-firstStarted:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for _, action := range []string{"background-one", "background-two"} {
		go func(action string) { _, err := c.request(ctx, "vod", action, url.Values{}); results <- err }(action)
	}
	go func() {
		_, err := c.Resolve(ctx, model.Item{ID: "live:1", Kind: "live", Command: "channel"})
		results <- err
	}()
	waitForPlaybackWaiter(t, c.mu)
	releaseOnce.Do(func() { close(release) })
	for range 4 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(actions) != 4 || actions[0] != "active" || actions[1] != "create_link" {
		t.Fatal("queued background work delayed playback", actions)
	}
	for i := 1; i < len(starts); i++ {
		if starts[i].Sub(starts[i-1]) < 60*time.Millisecond {
			t.Fatal("playback bypassed shared request pacing", starts)
		}
	}
}

func TestCanceledPlaybackWaiterDoesNotBlockBackgroundWork(t *testing.T) {
	gate := newRequestGate()
	if err := gate.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), playbackRequestKey{}, true))
	done := make(chan error, 1)
	go func() { done <- gate.acquire(ctx) }()
	waitForPlaybackWaiter(t, gate)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	gate.release()
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := gate.acquire(ctx); err != nil {
		t.Fatal("cancelled playback stranded background requests", err)
	}
	gate.release()
}
