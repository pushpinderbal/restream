import type { Category, CategoryPreference, Item, Preferences } from "./api";

const normalize = (value: string) => value.trim().toLowerCase();

function categoryMatcher(selectors: string[]) {
  const groups = new Map<string, Set<string>>();
  for (const selector of selectors) {
    const value = normalize(selector);
    const separator = value.indexOf(":");
    const prefix = value.slice(0, separator);
    const scoped =
      separator >= 0 && ["live", "movie", "series"].includes(prefix);
    const kind = scoped ? prefix : "";
    const category = scoped ? value.slice(separator + 1).trim() : value;
    const group = groups.get(kind) || new Set<string>();
    group.add(category);
    groups.set(kind, group);
  }
  return (kind: string, id: string, name: string) =>
    [groups.get(""), groups.get(kind)].some(
      (group) =>
        group?.has("*") ||
        (!!id && group?.has(normalize(id))) ||
        (!!name && group?.has(normalize(name))),
    );
}

export function createContentPolicy(
  preferences: Preferences | null,
  categories: Category[],
) {
  const key = (kind: string, id: string) => `${kind}\u0000${normalize(id)}`;
  const configuration = preferences?.configuration;
  const dashboardMatches = categoryMatcher(
    configuration?.dashboardCategories || [],
  );
  const blockedMatches = categoryMatcher(
    configuration?.blockedCategories || [],
  );
  const environmentRule = (
    kind: Category["kind"],
    id: string,
    name: string,
  ): CategoryPreference => ({
    kind,
    id,
    visibility: blockedMatches(kind, id, name) ? "block" : "show",
    dashboard:
      !configuration?.dashboardCategories.length ||
      dashboardMatches(kind, id, name),
  });
  const byID = new Map(
    (preferences?.categories || []).map((rule) => [
      key(rule.kind, rule.id),
      rule,
    ]),
  );
  const byName = new Map<string, CategoryPreference>();
  const priority = (rule: CategoryPreference) =>
    rule.visibility === "block" ? 2 : !rule.dashboard ? 1 : 0;
  // History entries may have a category name without its provider ID.
  for (const category of categories) {
    const rule = configuration
      ? environmentRule(category.kind, category.id, category.name)
      : byID.get(key(category.kind, category.id));
    if (!rule) continue;
    byID.set(key(category.kind, category.id), rule);
    const name = key(category.kind, category.name);
    const previous = byName.get(name);
    if (!previous || priority(rule) > priority(previous))
      byName.set(name, rule);
  }
  const categoryPreference = (item: Item) => {
    const kind = item.kind === "episode" ? "series" : item.kind;
    const known =
      (item.categoryId && byID.get(key(kind, item.categoryId))) ||
      byName.get(key(kind, item.category));
    if (!configuration) return known || undefined;
    // Apply environment rules even to history from categories no longer cached.
    const direct = environmentRule(kind, item.categoryId || "", item.category);
    return known
      ? {
          ...known,
          visibility:
            priority(direct) > priority(known)
              ? direct.visibility
              : known.visibility,
        }
      : direct;
  };
  return {
    categoryPreference,
    isVisible: (item: Item) => {
      const rule = categoryPreference(item);
      return !rule || rule.visibility === "show";
    },
    isDashboardAllowed: (item: Item) => {
      const rule = categoryPreference(item);
      return (
        !!preferences &&
        (!rule || rule.visibility === "show") &&
        rule?.dashboard !== false
      );
    },
  };
}
