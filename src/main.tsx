// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CreateWindow } from "./CreateWindow";
import "./index.css";
import { initTheme } from "./lib/theme";

initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get("window") === "create" ? <CreateWindow /> : <App />}
  </React.StrictMode>
);
