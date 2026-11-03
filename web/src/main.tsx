import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { AuthGate } from "./auth";
import { trackInputModality } from "./lib/input-modality";
import { trackAppViewport } from "./lib/viewport";
import "@fontsource-variable/manrope";
import "./styles.css";

const stopTrackingInput = trackInputModality();
const stopTrackingViewport = trackAppViewport();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopTrackingInput();
    stopTrackingViewport();
  });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthGate>
        <App />
      </AuthGate>
    </BrowserRouter>
  </React.StrictMode>,
);
