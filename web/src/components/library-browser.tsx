import { useId, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Category } from "../api";
import { CategorySelect } from "./category-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { TabIndicator } from "./ui/tab-indicator";

type LibraryTab = "movie" | "series" | "live";
const labels = { movie: "Movies", series: "Shows", live: "Live TV" };

export function LibraryBrowser({
  mode,
  tab,
  categories,
  category,
  playerActive,
  onTabChange,
  onCategoryChange,
  children,
}: {
  mode: "vod" | "live";
  tab: LibraryTab;
  categories: Category[];
  category: string;
  playerActive: boolean;
  onTabChange: (tab: LibraryTab) => void;
  onCategoryChange: (category: string) => void;
  children: ReactNode;
}) {
  const indicatorId = useId();
  const reducedMotion = useReducedMotion();
  const categoryMenu = (
    <CategorySelect
      categories={categories}
      value={category}
      onValueChange={onCategoryChange}
    />
  );

  if (mode === "live" || (mode === "vod" && playerActive)) {
    return (
      <section className="section-view" aria-label={`${labels[tab]} library`}>
        <div className="browse-heading">
          <div className="browse-toolbar">{categoryMenu}</div>
        </div>
        {children}
      </section>
    );
  }

  return (
    <Tabs
      className="section-view"
      role="region"
      aria-label={`${labels[tab]} library`}
      value={tab}
      onValueChange={(value) => onTabChange(value as LibraryTab)}
      activationMode="manual"
    >
      <div className="browse-heading">
        <div className="browse-toolbar">
          <TabsList className="vod-type-tabs" aria-label="VOD type">
            {(["movie", "series"] as const).map((value) => (
              <TabsTrigger className="section-tab" key={value} value={value}>
                {labels[value]}
                {tab === value && <TabIndicator id={indicatorId} />}
              </TabsTrigger>
            ))}
          </TabsList>
          {categoryMenu}
        </div>
      </div>
      <TabsContent value={tab} className="catalog-tab-panel">
        <motion.div
          key={tab}
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }}
        >
          {children}
        </motion.div>
      </TabsContent>
    </Tabs>
  );
}
