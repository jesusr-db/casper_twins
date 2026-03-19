import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import "./styles/dominos-theme.css";
import "maplibre-gl/dist/maplibre-gl.css";

// CXPanel imported in Task 5 after the component file is created
const CXPlaceholder: React.FC = () => (
  <div style={{ padding: 40, color: "#8ab4d4" }}>Customer Experience — coming soon</div>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/cx" element={<CXPlaceholder />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
