import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./auth";
import { trackInputModality } from "./lib/input-modality";
import { trackViewportOrientation } from "./lib/viewport";
import "@fontsource-variable/manrope";
import "./styles.css";

const stopTrackingInput = trackInputModality();
const stopTrackingViewport = trackViewportOrientation();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopTrackingInput();
    stopTrackingViewport();
  });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
