package app

import (
	"bytes"
	"context"
	"math/bits"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stream"
)

func TestEmbeddedCaptionsAcrossPlaybackModes(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	movie := embeddedCaptionFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, movie)
	}))
	defer upstream.Close()
	for _, mode := range []string{"copy", "transcode"} {
		t.Run(mode, func(t *testing.T) {
			m, err := stream.New(stream.Config{MaxStreams: 1, SessionTTL: time.Minute, DataDir: t.TempDir(), TranscodeMode: mode}, func(context.Context, model.Item) (model.Source, error) {
				return model.Source{URL: upstream.URL + "/captions.mp4"}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			media := httptest.NewServer(m.MediaHandler())
			defer media.Close()
			for _, offset := range []float64{0, 43} {
				s, err := m.Start(context.Background(), model.Item{Kind: "episode", ID: "episode:4:1:1"}, offset)
				if err != nil {
					t.Fatal(err)
				}
				deadline := time.Now().Add(10 * time.Second)
				for s.State == "starting" && time.Now().Before(deadline) {
					time.Sleep(20 * time.Millisecond)
					s, err = m.Get(s.ID)
					if err != nil {
						t.Fatal(err)
					}
				}
				if s.State != "ready" && s.State != "ended" {
					t.Fatalf("caption relay did not start: %+v", s)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				input := strings.ReplaceAll(media.URL+s.URL, ":", "\\:")
				cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "movie='"+input+"'[out0+subcc]", "-map", "0:s:0", "-t", "4", "-c:s", "webvtt", "-f", "webvtt", "-")
				output, err := cmd.CombinedOutput()
				cancel()
				if err != nil || !bytes.Contains(output, []byte("Embedded caption fixture")) {
					t.Fatalf("embedded captions lost in %s at %.0fs: %v %s", mode, offset, err, output)
				}
				if err := m.Stop(s.ID); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

// Generate a deterministic H.264 stream with real CEA-608 popup captions in
// registered A53 SEI messages. The fixture has no subtitle stream or sidecar.
func embeddedCaptionFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	raw := filepath.Join(dir, "raw.h264")
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "64", "-c:v", "libx264", "-preset", "ultrafast", "-g", "200", "-bf", "0", "-x264-params", "aud=1", "-f", "h264", raw)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate caption video: %v %s", err, output)
	}
	data, err := os.ReadFile(raw)
	if err != nil {
		t.Fatal(err)
	}
	startCode := []byte{0, 0, 0, 1}
	var out bytes.Buffer
	frame := -1
	for _, nal := range bytes.Split(data, startCode) {
		if len(nal) == 0 {
			continue
		}
		out.Write(startCode)
		if nal[0]&31 != 9 { // Access unit delimiter: one per frame.
			out.Write(nal)
			continue
		}
		frame++
		if frame%25 != 0 {
			out.Write(nal)
			continue
		}
		out.Write(nal[:2])
		pairs := [][2]byte{{0x14, 0x2c}} // Clear the displayed caption.
		if frame%50 == 0 {
			pairs = [][2]byte{{0x14, 0x20}, {0x14, 0x2e}, {0x11, 0x40}}
			text := []byte("Embedded caption fixture")
			for i := 0; i < len(text); i += 2 {
				pairs = append(pairs, [2]byte{text[i], text[i+1]})
			}
			pairs = append(pairs, [2]byte{0x14, 0x2f}) // Display loaded popup.
		}
		payload := []byte{0xb5, 0, 0x31, 'G', 'A', '9', '4', 3, 0x40 | byte(len(pairs)), 0xff}
		for _, pair := range pairs {
			parity := func(b byte) byte {
				if bits.OnesCount8(b)%2 == 0 {
					return b | 0x80
				}
				return b
			}
			payload = append(payload, 0xfc, parity(pair[0]), parity(pair[1]))
		}
		payload = append(payload, 0xff)
		sei := append([]byte{4, byte(len(payload))}, payload...)
		sei = append(sei, 0x80)
		out.Write(startCode)
		out.WriteByte(6)
		zeros := 0
		for _, b := range sei {
			if zeros == 2 && b <= 3 {
				out.WriteByte(3)
				zeros = 0
			}
			out.WriteByte(b)
			if b == 0 {
				zeros++
			} else {
				zeros = 0
			}
		}
		out.Write(nal[2:])
	}
	captioned := filepath.Join(dir, "captions.h264")
	if err := os.WriteFile(captioned, out.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	movie := filepath.Join(dir, "captions.mp4")
	cmd = exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-r", "25", "-i", captioned, "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "64", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", movie)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("mux caption fixture: %v %s", err, output)
	}
	return movie
}
