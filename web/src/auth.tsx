import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { request } from "./api";
import { BrandMark } from "./components/brand-mark";
import { Button } from "./components/ui/button";
import { LoadingButton } from "./components/spectrumui/loading-button";
import { AnimatedAlert } from "./components/spectrumui/animated-alert";

type AuthState = {
  mode: "none" | "oidc";
  user: null | { id: string; name: string; role: "viewer" | "admin" };
};
type AuthContextValue = AuthState & {
  canAdmin: boolean;
  logout: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("Authentication context is missing");
  return auth;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const check = useCallback(async (foreground = false) => {
    const current = ++generation.current;
    if (foreground) setLoading(true);
    setError("");
    try {
      const next = await request<AuthState>("/api/auth", { cache: "no-store" });
      if (
        next.mode !== "none" &&
        (next.mode !== "oidc" ||
          (next.user !== null &&
            (!next.user?.id || !["viewer", "admin"].includes(next.user.role))))
      )
        throw new Error("Invalid authentication response");
      if (current === generation.current) setAuth(next);
    } catch {
      if (current === generation.current) {
        setAuth(null);
        setError("Unable to check your session. Please try again.");
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notifications =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("restream:auth");
    channel.current = notifications;
    const recheck = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(), 50);
    };
    const visible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    if (notifications) notifications.onmessage = recheck;
    void check(true).then(() => {
      if (active) notifications?.postMessage("changed");
    });
    const changed = (event: Event) => {
      if ((event as CustomEvent<number>).detail === 401) {
        ++generation.current;
        setLoading(false);
        setError("");
        setAuth({ mode: "oidc", user: null });
        notifications?.postMessage("changed");
      } else recheck();
    };
    window.addEventListener("restream:auth-changed", changed);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      ++generation.current;
      clearTimeout(timer);
      notifications?.close();
      channel.current = null;
      window.removeEventListener("restream:auth-changed", changed);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [check]);
  const logout = useCallback(async () => {
    await request<void>("/auth/logout", { method: "POST" });
    ++generation.current;
    setAuth({ mode: "oidc", user: null });
    channel.current?.postMessage("changed");
  }, []);
  if (!loading && auth && (auth.mode === "none" || auth.user)) {
    return (
      <AuthContext.Provider
        key={`${auth.mode}:${auth.user?.id || "anonymous"}:${auth.user?.role || ""}`}
        value={{
          ...auth,
          canAdmin: auth.mode === "none" || auth.user?.role === "admin",
          logout,
        }}
      >
        {children}
      </AuthContext.Provider>
    );
  }
  const loginError = new URLSearchParams(window.location.search).get(
    "auth_error",
  );
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section
        className="flex w-full max-w-sm flex-col items-start gap-6"
        aria-label="Sign in"
      >
        <BrandMark className="size-12" />
        <div>
          <h1 className="text-2xl font-semibold">Welcome to Restream</h1>
          <p className="mt-2 text-muted-foreground">
            Sign in to watch your library.
          </p>
        </div>
        {loading ? (
          <LoadingButton
            className="w-full"
            loading
            loadingLabel="Checking session…"
          >
            Checking session
          </LoadingButton>
        ) : error ? (
          <>
            <AnimatedAlert variant="error">{error}</AnimatedAlert>
            <Button className="w-full" onClick={() => void check(true)}>
              Try again
            </Button>
          </>
        ) : (
          <>
            {loginError && (
              <AnimatedAlert variant="error">
                {loginError === "access_denied"
                  ? "Your account does not have access to Restream. Contact your administrator."
                  : "Sign-in could not be completed. Please try again."}
              </AnimatedAlert>
            )}
            <Button className="w-full" asChild>
              <a href="/auth/login">Sign in</a>
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
