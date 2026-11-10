import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router";
import { AdminLayout, AppLayout, PublicLayout } from "./components/layouts";
import { initPwa } from "./lib/pwa";
import { SessionProvider } from "./lib/session";
import Admin from "./screens/admin/Admin";
import { MeScreen, Notifications, Settings, Standing, Verify } from "./screens/app/Account";
import Chat from "./screens/app/Chat";
import Discover from "./screens/app/Discover";
import Matches from "./screens/app/Matches";
import { AgeStep, EmailStep, Pending, ProfileEditor, ProviderPractice } from "./screens/app/Onboarding";
import { Login, ResetConfirm, ResetRequest, Signup, VerifyEmail } from "./screens/public/Auth";
import { AboutSample, Contact, Guidelines, Install, NotFound, Privacy, Safety, Terms } from "./screens/public/Pages";
import Welcome from "./screens/public/Welcome";
import "./styles/app.css";

const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    children: [
      { path: "/", element: <Welcome /> },
      { path: "/signup", element: <Signup /> },
      { path: "/login", element: <Login /> },
      { path: "/verify-email", element: <VerifyEmail /> },
      { path: "/reset", element: <ResetRequest /> },
      { path: "/reset/confirm", element: <ResetConfirm /> },
      { path: "/install", element: <Install /> },
      { path: "/contact", element: <Contact /> },
      { path: "/guidelines", element: <Guidelines /> },
      { path: "/terms", element: <Terms /> },
      { path: "/privacy", element: <Privacy /> },
      { path: "/safety", element: <Safety /> },
      { path: "/about-sample", element: <AboutSample /> },
      { path: "/appeal", element: <Navigate to="/app/standing" replace /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  {
    path: "/app",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/app/discover" replace /> },
      { path: "email", element: <EmailStep /> },
      { path: "age", element: <AgeStep /> },
      { path: "profile", element: <ProfileEditor /> },
      { path: "pending", element: <Pending /> },
      { path: "discover", element: <Discover /> },
      { path: "matches", element: <Matches /> },
      { path: "chat/:id", element: <Chat /> },
      { path: "verify", element: <Verify /> },
      { path: "me", element: <MeScreen /> },
      { path: "notifications", element: <Notifications /> },
      { path: "settings", element: <Settings /> },
      { path: "standing", element: <Standing /> },
    ],
  },
  // The practice provider page sits where the mock provider sends people (core/providers.ts): /dev/provider.
  { path: "/dev", element: <AppLayout />, children: [{ path: "provider", element: <ProviderPractice /> }] },
  { path: "/admin", element: <AdminLayout />, children: [{ index: true, element: <Admin /> }, { path: ":section", element: <Admin /> }, { path: ":section/:id", element: <Admin /> }] },
]);

initPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
