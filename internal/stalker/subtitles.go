package stalker

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"

	"github.com/pushpinderbal/restream/internal/model"
)

func (c *Client) playbackSubtitles(ctx context.Context, response map[string]json.RawMessage, base *url.URL) []model.SubtitleSource {
	var rows []map[string]json.RawMessage
	if json.Unmarshal(response["subtitles"], &rows) != nil {
		return nil
	}
	var tracks []model.SubtitleSource
	for _, row := range rows {
		if len(tracks) >= 16 {
			break
		}
		uri := str(row, "url", "src", "file")
		if uri == "" {
			continue
		}
		u, err := base.Parse(uri)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			continue
		}
		headers, err := c.playbackHeaders(ctx, u)
		if err != nil {
			continue
		}
		language := str(row, "language", "lang", "srclang")
		label := str(row, "label", "name", "title")
		if strings.TrimSpace(label) == "" {
			label = language
		}
		tracks = append(tracks, model.SubtitleSource{URL: u.String(), Label: label, Language: language, Headers: headers, Default: flag(row, "default"), Forced: flag(row, "forced")})
	}
	return tracks
}
