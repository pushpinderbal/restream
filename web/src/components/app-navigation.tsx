import { BroadcastIcon } from "@phosphor-icons/react/dist/csr/Broadcast";
import { CompassIcon } from "@phosphor-icons/react/dist/csr/Compass";
import { FilmReelIcon } from "@phosphor-icons/react/dist/csr/FilmReel";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { BrandMark } from "./brand-mark";
import "./navigation.css";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

type Destination = "home" | "search" | "vod" | "live" | "settings";
const destinations = [
  { id: "search", label: "Search", icon: MagnifyingGlassIcon },
  { id: "home", label: "Home", icon: CompassIcon },
  { id: "vod", label: "VOD", icon: FilmReelIcon },
  { id: "live", label: "Live TV", icon: BroadcastIcon },
  { id: "settings", label: "Settings", icon: SlidersHorizontalIcon },
] as const;

export function AppNavigation({
  active,
  onNavigate,
}: {
  active: Destination;
  onNavigate: (destination: Destination) => void;
}) {
  const renderLink = ({
    id,
    label,
    icon: Icon,
  }: (typeof destinations)[number]) => (
    <Button
      key={id}
      variant="ghost"
      size="icon-lg"
      className={`navigation-icon${active === id ? " active" : ""}`}
      aria-label={label}
      aria-current={active === id ? "page" : undefined}
      onClick={() => onNavigate(id)}
    >
      <Icon
        className="size-[32px]"
        size={32}
        weight={active === id ? "fill" : "duotone"}
        aria-hidden="true"
      />
    </Button>
  );
  const desktopLinks = destinations.map((destination) => (
    <Tooltip key={destination.id}>
      <TooltipTrigger asChild>{renderLink(destination)}</TooltipTrigger>
      <TooltipContent className="navigation-tooltip" side="right">
        {destination.id === "vod" ? "Movies & shows" : destination.label}
      </TooltipContent>
    </Tooltip>
  ));
  return (
    <>
      <TooltipProvider delayDuration={400} skipDelayDuration={200}>
        <aside className="app-sidebar">
          <button
            className="sidebar-brand"
            aria-label="Restream home"
            onClick={() => onNavigate("home")}
          >
            <BrandMark />
          </button>
          <nav className="side-navigation" aria-label="Library">
            <div className="navigation-main">{desktopLinks.slice(0, 4)}</div>
            <div className="navigation-footer">{desktopLinks[4]}</div>
          </nav>
        </aside>
      </TooltipProvider>
      <nav className="mobile-bottom-nav" aria-label="Primary navigation">
        {destinations.map(renderLink)}
      </nav>
    </>
  );
}
