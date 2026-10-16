import { FilmSlateIcon } from "@phosphor-icons/react/dist/csr/FilmSlate";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
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
  { id: "home", label: "Home", icon: HouseIcon },
  { id: "vod", label: "VOD", icon: FilmSlateIcon },
  { id: "live", label: "Live TV", icon: MonitorIcon },
  { id: "settings", label: "Settings", icon: UserCircleIcon },
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
      className={`navigation-icon${active === id ? " active" : ""}${id === "settings" ? " navigation-profile" : ""}`}
      aria-label={label}
      aria-current={active === id ? "page" : undefined}
      onClick={() => onNavigate(id)}
    >
      <Icon
        className="size-[32px]"
        size={32}
        weight="light"
        aria-hidden="true"
      />
    </Button>
  );
  const desktopLinks = destinations.map((destination) => (
    <Tooltip key={destination.id}>
      <TooltipTrigger asChild>{renderLink(destination)}</TooltipTrigger>
      <TooltipContent className="navigation-tooltip" side="right">
        {destination.id === "settings"
          ? "Profile & settings"
          : destination.id === "vod"
            ? "Movies & shows"
            : destination.label}
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
