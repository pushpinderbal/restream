1. Do not write unit tests for everything. Prefer integration tests.
2. Prefer trusted libraries over hand-rolling complexity.
3. Prefer modern, cohesive UI built with shadcn/ui, Spectrum UI, Radix UI, and Tailwind. Check these libraries and reuse the app's existing components before creating custom UI. Use shared variants and theme tokens for consistent buttons, controls, spacing, and interaction states; avoid one-off designs or style overrides when a suitable design component exists.
4. For UI work, run the app and test it in a browser, including primary interactions and desktop/mobile layouts.
5. README is user-facing, made for humans and should follow human readable language. It doesn't have to include each and every technical detail, focus more on the user pov, it should focus on helping the user understand the app, it's features and how to quickly get started.
