package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFrontendDeepLinksServeAppWithoutMaskingMissingFiles(t *testing.T) {
	root := t.TempDir()
	const page = "<!doctype html><title>Restream</title>"
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte(page), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: Config{WebDir: root}}
	server := httptest.NewServer(s.static())
	defer server.Close()
	for _, path := range []string{"/", "/movies?category=8", "/shows", "/live", "/search?q=Film", "/settings", "/movies/movie%3A2", "/shows/series%3A2/watch?season=1&episode=episode%3A2%3A1%3A1", "/live/channel%2Fopaque/watch"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			req, _ := http.NewRequest(method, server.URL+path, nil)
			response, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/html") || method == http.MethodGet && string(body) != page || method == http.MethodHead && len(body) != 0 {
				t.Fatalf("%s %s: status=%d body=%q", method, path, response.StatusCode, body)
			}
		}
	}
	for _, path := range []string{"/assets/missing.js", "/missing.png", "/api/missing", "/unknown", "/movies/id/unknown"} {
		response, err := server.Client().Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: expected 404, got %d", path, response.StatusCode)
		}
	}
	if err := os.Remove(filepath.Join(root, "index.html")); err != nil {
		t.Fatal(err)
	}
	response, err := server.Client().Get(server.URL + "/movies")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("missing frontend: got %d", response.StatusCode)
	}
}
