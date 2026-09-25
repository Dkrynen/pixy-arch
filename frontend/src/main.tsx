import React from "react";
import ReactDOM from "react-dom/client";

// Fonts are bundled locally so the deck works offline and never calls out.
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
// Base design system first; component stylesheets (imported by App) layer on top.
import "./styles.css";

import { App } from "./app/App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
