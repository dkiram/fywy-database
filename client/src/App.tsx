import { Route, Routes } from "react-router";
import AppLayout from "./components/AppLayout";
import LoginPage from "./pages/LoginPage";
import CustomerSearchPage from "./pages/CustomerSearchPage";
import CustomerProfilePage from "./pages/CustomerProfilePage";

function App() {
  return (
    <Routes>
      {/* Login does NOT use the app sidebar/header */}
      <Route
        path="/"
        element={<LoginPage />}
      />

      {/* Main application */}
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
    </Routes>
  );
}

export default App;