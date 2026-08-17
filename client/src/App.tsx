/** Declares every client-side route and wraps protected screens in the shared app shell. */
import { Route, Routes } from "react-router";
import AppLayout from "./components/AppLayout";
import LoginPage from "./pages/LoginPage";
import CustomerSearchPage from "./pages/CustomerSearchPage";
import CustomerProfilePage from "./pages/CustomerProfilePage";
import EditCustomerProfilePage from "./pages/EditCustomerProfilePage";
import DashboardPage from "./pages/DashboardPage";
import ApplicationsPage from "./pages/ApplicationsPage";
import ServiceRequestsPage from "./pages/ServiceRequestsPage";
import PoleBoxesPage from "./pages/PoleBoxesPage";
import ReportsPage from "./pages/ReportsPage";
import ActivityHistoryPage from "./pages/ActivityHistoryPage";
import AdminControlsPage from "./pages/AdminControlsPage";
import SettingsPage from "./pages/SettingsPage";
import PaymentsPage from "./pages/PaymentsPage";
import AccountOperationsPage from "./pages/AccountOperationsPage";
import ProtectedRoute from "./auth/ProtectedRoute";

function App() {
  return (
    <Routes>
      {/* Login does NOT use the app sidebar/header */}
  <Route path="/" element={<LoginPage />} />

  {/* Dashboard data is administrator-only; denied roles return to Customers. */}
  <Route
    path="/dashboard"
    element={
      <ProtectedRoute allowedRoles={["admin"]}>
        <AppLayout>
          <DashboardPage />
        </AppLayout>
      </ProtectedRoute>
    }
  />

  {/* Daily collection totals are administrator-only. */}
  <Route
    path="/payments"
    element={
      <ProtectedRoute allowedRoles={["admin"]}>
        <AppLayout>
          <PaymentsPage />
        </AppLayout>
      </ProtectedRoute>
    }
  />

<Route
  path="/customers"
  element={
    <ProtectedRoute>
      <AppLayout>
        <CustomerSearchPage />
      </AppLayout>
    </ProtectedRoute>
  }
/>

<Route
  path="/customers/:customerId"
  element={
    <ProtectedRoute>
      <AppLayout>
        <CustomerProfilePage />
      </AppLayout>
    </ProtectedRoute>
  }
/>

<Route
  path="/customers/:customerId/edit"
  element={
    <ProtectedRoute allowedRoles={["admin", "head_office"]}>
      <AppLayout>
        <EditCustomerProfilePage />
      </AppLayout>
    </ProtectedRoute>
  }
/>

  <Route
    path="/applications"
    element={
    <ProtectedRoute>
      <AppLayout>
        <ApplicationsPage />
      </AppLayout>
    </ProtectedRoute>
    }
  />

  {/* MVP 3 account operations is protected and uses the normal app shell. */}
  <Route
    path="/account-operations"
    element={
      <ProtectedRoute allowedRoles={["admin", "head_office"]}>
        <AppLayout>
          <AccountOperationsPage />
        </AppLayout>
      </ProtectedRoute>
    }
  />

  <Route
    path="/service-requests"
    element={
    <ProtectedRoute>
      <AppLayout>
        <ServiceRequestsPage />
      </AppLayout>
    </ProtectedRoute>
    }
  />

  <Route
    path="/pole-boxes"
    element={
      <ProtectedRoute allowedRoles={["admin", "head_office"]}>
      <AppLayout>
        <PoleBoxesPage />
      </AppLayout>
    </ProtectedRoute>
    }
  />

  <Route
    path="/reports"
    element={
      <ProtectedRoute allowedRoles={["admin", "head_office"]}>
      <AppLayout>
        <ReportsPage />
      </AppLayout>
    </ProtectedRoute>
    }
  />

  <Route
    path="/activity-history"
    element={
    <ProtectedRoute>
      <AppLayout>
        <ActivityHistoryPage />
      </AppLayout>
    </ProtectedRoute>
    }
  />

<Route
  path="/admin"
  element={
    <ProtectedRoute
      allowedRoles={["admin"]}
    >
      <AppLayout>
        <AdminControlsPage />
      </AppLayout>
    </ProtectedRoute>
  }
/>

  <Route
    path="/settings"
    element={
    <ProtectedRoute>
      <AppLayout>
        <SettingsPage />
      </AppLayout>
    </ProtectedRoute>
    }
  />
</Routes>
  );
}

export default App;
