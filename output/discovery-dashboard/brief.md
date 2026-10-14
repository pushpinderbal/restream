# Restream discovery dashboard — planning brief

The home screen should help viewers pick something to watch, with varied card sizes and a clear visual hierarchy. The current sparse history groups need a richer composition: featured artwork, Continue watching, Up next, Trending movies and shows, and Live now.

## Availability rule

Only external discovery titles confirmed in the current provider catalogue may appear in Trending or featured discovery. Unmatched titles, known unavailable titles, and titles whose availability has not yet been checked are excluded. Catalogue matches must be revalidated as provider listings change. External metadata supplies discovery and artwork; playback remains through the configured provider.

## Proposed responsibility split

- Server: metadata credentials, cached trend feeds, title matching, provider availability and shared metadata.
- Browser initially: personal history, playback progress and completion state.
- Up next: personal watch state combined with the provider's actual available episode order.

The provider catalogue is loaded on demand. Check a bounded set of candidates in the background, cache successful matches, and serve the dashboard without blocking on metadata searches or fetching all seasons. Missing entries in the local catalogue cache do not prove that the provider lacks a title.

With no viewing history, hide the personal sections and use available featured titles, trends and Live now. If metadata is not configured, use actual provider listings and the programme guide rather than labelling ordinary catalogue items as trending.

## Implementation status

Implemented the featured dashboard, browser-local progress and Resume, bounded Up next lookup, Live now and filterable Recently played. Server-side TMDB discovery, conservative provider matching, persistent caching and local artwork proxying are implemented and covered by integration tests.

The current instance has no TMDB credential, so the live dashboard uses actual provider titles under Explore. Genuine Trending becomes available after configuring the app's own TMDB credential and restarting. See the [live review](../discovery-dashboard-review/README.md) for screenshots and validation evidence.
