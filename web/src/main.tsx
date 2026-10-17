import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./auth";
import { trackInputModality } from "./lib/input-modality";
import "@fontsource-variable/manrope";
import "./styles.css";

const stopTrackingInput = trackInputModality();
if (import.meta.hot) import.meta.hot.dispose(stopTrackingInput);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
