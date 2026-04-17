import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import { CXPanel } from "./components/cx/CXPanel";
import "./styles/dominos-theme.css";
import "maplibre-gl/dist/maplibre-gl.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/cx" element={<CXPanel />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
