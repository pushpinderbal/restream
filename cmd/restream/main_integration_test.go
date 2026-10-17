package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDevelopmentServerUsesLocalPaths(t *testing.T) {
	work := t.TempDir()
	binary := filepath.Join(t.TempDir(), "restream")
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build development binary: %v\n%s", err, output)
	}
	web := filepath.Join(work, "web", "dist")
	if err := os.MkdirAll(web, 0700); err != nil {
		t.Fatal(err)
	}
	const page = "<html>local development</html>"
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte(page), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	t.Setenv("TMDB_API_READ_ACCESS_TOKEN", "ignored-environment-setting")
	t.Setenv("LISTEN_ADDR", address)
	cmd := exec.Command(binary, "--dev")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "STALKER_PORTAL_URL", "STALKER_MAC", "STALKER_TIMEZONE", "STALKER_SERIAL_NUMBER", "STALKER_DEVICE_ID", "STALKER_DEVICE_ID2":
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Dir = work
	var logs bytes.Buffer
	cmd.Stdout, cmd.Stderr = &logs, &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		select {
		case <-done:
			if waitErr != nil {
				t.Errorf("development server exit: %v\n%s", waitErr, logs.String())
			}
		case <-time.After(15 * time.Second):
			_ = cmd.Process.Kill()
			<-done
			t.Errorf("development server did not shut down gracefully\n%s", logs.String())
		}
	})
	client := &http.Client{Timeout: time.Second}
	base := "http://" + address
	deadline := time.Now().Add(10 * time.Second)
	for {
		select {
		case <-done:
			t.Fatalf("development server stopped: %v\n%s", waitErr, logs.String())
		default:
		}
		response, err := client.Get(base + "/healthz")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("development server did not become healthy")
		}
		time.Sleep(50 * time.Millisecond)
	}
	status, err := client.Get(base + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	statusBody, err := io.ReadAll(status.Body)
	status.Body.Close()
	if err != nil || status.StatusCode != http.StatusOK || !bytes.Contains(statusBody, []byte(`"configured":false`)) {
		t.Fatalf("unconfigured provider unexpectedly configured the runtime: status=%d body=%s err=%v", status.StatusCode, statusBody, err)
	}
	response, err := client.Get(base)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != page {
		t.Fatalf("local web files were not served: status=%d body=%s err=%v", response.StatusCode, body, err)
	}
	if _, err := os.Stat(filepath.Join(work, "data", "restream.sqlite")); err != nil {
		t.Fatalf("local database was not created: %v", err)
	}
}
