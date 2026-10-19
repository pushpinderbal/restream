import {
  defaultSubtitleAppearance,
  subtitleAppearanceOptions,
  useSubtitleAppearance,
  type SubtitleAppearance,
} from "../subtitle-appearance";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import "./subtitle-appearance-settings.css";

const labels: Record<keyof SubtitleAppearance, string> = {
  font: "Font",
  size: "Text size",
  color: "Text color",
  background: "Background",
};

export function SubtitleAppearanceSettings() {
  const {
    appearance,
    style,
    storageAvailable,
    updateAppearance,
    resetAppearance,
  } = useSubtitleAppearance();
  const isDefault = Object.keys(defaultSubtitleAppearance).every(
    (key) =>
      appearance[key as keyof SubtitleAppearance] ===
      defaultSubtitleAppearance[key as keyof SubtitleAppearance],
  );
  return (
    <section
      id="settings-subtitles"
      tabIndex={-1}
      className="settings-section"
      aria-labelledby="settings-subtitles-title"
    >
      <div className="settings-section-intro">
        <h2 id="settings-subtitles-title">Subtitles</h2>
        <p>
          Make captions comfortable to read. These choices apply to this
          browser.
        </p>
      </div>
      <div className="subtitle-appearance-layout">
        <div className="subtitle-appearance-controls">
          <div className="settings-fields">
            {(Object.keys(labels) as (keyof SubtitleAppearance)[]).map(
              (key) => (
                <div key={key}>
                  <Label
                    htmlFor={`subtitle-${key}`}
                    id={`subtitle-${key}-label`}
                  >
                    {labels[key]}
                  </Label>
                  <Select
                    value={appearance[key]}
                    onValueChange={(value) =>
                      updateAppearance({ [key]: value })
                    }
                  >
                    <SelectTrigger
                      size="form"
                      id={`subtitle-${key}`}
                      aria-labelledby={`subtitle-${key}-label`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {subtitleAppearanceOptions[key].map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ),
            )}
          </div>
          <div className="subtitle-appearance-footer">
            <p className="settings-field-help" role="status">
              {storageAvailable
                ? "Changes apply immediately and are saved in this browser."
                : "Changes apply immediately. Browser storage is unavailable, so they last for this tab only."}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isDefault}
              onClick={resetAppearance}
            >
              Reset subtitle style
            </Button>
          </div>
        </div>
        <figure className="subtitle-appearance-preview" style={style}>
          <div
            className="subtitle-preview-frame"
            role="img"
            aria-label="Subtitle style preview"
          >
            <svg viewBox="0 0 640 360" aria-hidden="true" focusable="false">
              <defs>
                <linearGradient id="subtitle-preview-sky" x2="0" y2="1">
                  <stop stopColor="#243f57" />
                  <stop offset="1" stopColor="#729ba4" />
                </linearGradient>
                <linearGradient id="subtitle-preview-water" x2="0" y2="1">
                  <stop stopColor="#457b8b" />
                  <stop offset="1" stopColor="#163e50" />
                </linearGradient>
              </defs>
              <path fill="url(#subtitle-preview-sky)" d="M0 0h640v360H0z" />
              <circle cx="473" cy="91" r="36" fill="#e5cfaa" opacity=".8" />
              <path
                fill="#36596a"
                d="m0 195 98-83 119 112 108-66 126 76 108-47 81 34v139H0z"
              />
              <path fill="url(#subtitle-preview-water)" d="M0 235h640v125H0z" />
              <path fill="#192e39" d="m0 235 96 11 114 52 60 62H0z" />
              <path
                stroke="#c2d8d5"
                opacity=".22"
                d="M418 250h111m-135 15h169m-152 17h139m-159 17h195"
              />
            </svg>
            <div className="subtitle-preview-caption" aria-hidden="true">
              <span>The coast is clear.</span>
              <br />
              <span>Let’s see what comes next.</span>
            </div>
          </div>
          <figcaption>Preview</figcaption>
        </figure>
      </div>
    </section>
  );
}
