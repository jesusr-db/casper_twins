import React from "react";
import { Routes, Route } from "react-router-dom";
import { TopNav } from "./components/TopNav";
import { MapShell } from "./pages/MapShell";
import { OperationsPage } from "./pages/OperationsPage";

const App: React.FC = () => {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopNav />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Routes>
          <Route path="/" element={<MapShell />} />
          <Route path="/operations" element={<OperationsPage />} />
        </Routes>
      </div>
    </div>
  );
};

export default App;
