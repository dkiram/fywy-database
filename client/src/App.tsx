import { Route, Routes } from "react-router";
import AppLayout from "./components/AppLayout";
import CustomerSearchPage from "./pages/CustomerSearchPage";
import CustomerProfilePage from "./pages/CustomerProfilePage";

function App() {
  return (
    <AppLayout>
      <Routes>
        <Route
          path="/"
          element={<CustomerSearchPage />}
        />

        <Route
          path="/customers/:customerId"
          element={<CustomerProfilePage />}
        />
      </Routes>
    </AppLayout>
  );
}

export default App;