import { Route, Routes } from "react-router";
import AppLayout from "./components/AppLayout";
import LoginPage from "./pages/LoginPage";
import CustomerSearchPage from "./pages/CustomerSearchPage";
import CustomerProfilePage from "./pages/CustomerProfilePage";
import DashboardPage from "./pages/DashboardPage";
import ApplicationsPage from "./pages/ApplicationsPage";
import ServiceRequestsPage from "./pages/ServiceRequestsPage";
import PoleBoxesPage from "./pages/PoleBoxesPage";
import ReportsPage from "./pages/ReportsPage";
import ActivityHistoryPage from "./pages/ActivityHistoryPage";
import AdminControlsPage from "./pages/AdminControlsPage";
import SettingsPage from "./pages/SettingsPage";

function App() {
  return (
    <Routes>
      {/* Login does NOT use the app sidebar/header */}
  <Route path="/" element={<LoginPage />} />

  <Route
    path="/dashboard"
    element={
      <AppLayout>
        <DashboardPage />
      </AppLayout>
    }
  />

  <Route
    path="/customers"
    element={
      <AppLayout>
        <CustomerSearchPage />
      </AppLayout>
    }
  />

  <Route
    path="/customers/:customerId"
    element={
      <AppLayout>
        <CustomerProfilePage />
      </AppLayout>
    }
  />

  <Route
    path="/applications"
    element={
      <AppLayout>
        <ApplicationsPage />
      </AppLayout>
    }
  />

  <Route
    path="/service-requests"
    element={
      <AppLayout>
        <ServiceRequestsPage />
      </AppLayout>
    }
  />

  <Route
    path="/pole-boxes"
    element={
      <AppLayout>
        <PoleBoxesPage />
      </AppLayout>
    }
  />

  <Route
    path="/reports"
    element={
      <AppLayout>
        <ReportsPage />
      </AppLayout>
    }
  />

  <Route
    path="/activity-history"
    element={
      <AppLayout>
        <ActivityHistoryPage />
      </AppLayout>
    }
  />

  <Route
    path="/admin"
    element={
      <AppLayout>
        <AdminControlsPage />
      </AppLayout>
    }
  />

  <Route
    path="/settings"
    element={
      <AppLayout>
        <SettingsPage />
      </AppLayout>
    }
  />
</Routes>
  );
}

export default App;