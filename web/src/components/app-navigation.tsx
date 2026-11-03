import { BroadcastIcon } from "@phosphor-icons/react/dist/csr/Broadcast";
import { CompassIcon } from "@phosphor-icons/react/dist/csr/Compass";
import { FilmReelIcon } from "@phosphor-icons/react/dist/csr/FilmReel";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { AccountMenu } from "./account-menu";
import { BrandMark } from "./brand-mark";
import { Link } from "react-router";
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
] as const;

export function AppNavigation({
  active,
  hrefs,
  onNavigate,
}: {
  active: Destination;
  hrefs: Record<Exclude<Destination, "settings">, string>;
  onNavigate: (destination: Destination) => void;
}) {
  const accountMenu = (
    <AccountMenu
      active={active === "settings"}
      onSettings={() => onNavigate("settings")}
    />
  );
  const renderLink = ({
    id,
    label,
    icon: Icon,
  }: (typeof destinations)[number]) => (
    <Button
      asChild
      key={id}
      variant="ghost"
      size="icon-lg"
      className={`navigation-icon${active === id ? " active" : ""}`}
      aria-label={label}
      aria-current={active === id ? "page" : undefined}
    >
      <Link
        to={hrefs[id]}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          onNavigate(id);
        }}
      >
        <Icon
          className="size-[32px]"
          size={32}
          weight={active === id ? "fill" : "duotone"}
          aria-hidden="true"
        />
      </Link>
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
          <Button
            asChild
            variant="ghost"
            size="icon-lg"
            className="sidebar-brand"
            aria-label="Restream home"
          >
            <Link
              to="/"
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onNavigate("home");
              }}
            >
              <BrandMark />
            </Link>
          </Button>
          <nav className="side-navigation" aria-label="Library">
            <div className="navigation-main">{desktopLinks}</div>
            <div className="navigation-footer">{accountMenu}</div>
          </nav>
        </aside>
      </TooltipProvider>
      <nav className="mobile-bottom-nav" aria-label="Primary navigation">
        {destinations.map(renderLink)}
        {accountMenu}
      </nav>
    </>
  );
}
