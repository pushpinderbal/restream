import { useState } from "react";
import { LoaderCircle, LogOut, Settings, UserRound } from "lucide-react";
import { useAuth } from "../auth";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { AnimatedAlert } from "./spectrumui/animated-alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function AccountMenu({
  active,
  onSettings,
}: {
  active: boolean;
  onSettings: () => void;
}) {
  const { user, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className={cn("navigation-icon", active && "active")}
          aria-label="Account"
          aria-current={active ? "page" : undefined}
        >
          <UserRound className="size-7" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-64"
        aria-label="Account"
      >
        <DropdownMenuLabel>
          <p className="break-words">
            {user ? user.name || "Restream user" : "Anonymous"}
          </p>
          <p className="mt-1 font-normal text-muted-foreground">
            {user
              ? user.role === "admin"
                ? "Administrator"
                : "Viewer"
              : "No sign-in required"}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={busy}
          aria-current={active ? "page" : undefined}
          onSelect={onSettings}
        >
          <Settings aria-hidden="true" />
          Settings
        </DropdownMenuItem>
        {user && (
          <DropdownMenuItem
            disabled={busy}
            onSelect={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              void logout().catch(() => {
                setError("Unable to sign out. Please try again.");
                setBusy(false);
              });
            }}
          >
            {busy ? (
              <LoaderCircle
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : (
              <LogOut aria-hidden="true" />
            )}
            {busy ? "Signing out…" : "Sign out"}
          </DropdownMenuItem>
        )}
        {error && (
          <div className="p-2">
            <AnimatedAlert variant="error">{error}</AnimatedAlert>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
