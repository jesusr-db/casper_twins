import React from "react";
import { Routes, Route } from "react-router-dom";
import { MapShell } from "./pages/MapShell";
import { OperationsPage } from "./pages/OperationsPage";

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<MapShell />} />
      <Route path="/operations" element={<OperationsPage />} />
    </Routes>
  );
};

export default App;
