import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import LoginPage from './pages/LoginPage';
import LibraryPage from './pages/LibraryPage';
import ProjectPage from './pages/ProjectPage';
import TransfersPage from './pages/TransfersPage';
import PlayerPage from './pages/PlayerPage';
import AdminPage from './pages/AdminPage';

function Shell() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#070b14]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" />
      </main>
    );
  }
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route path="/" element={<LibraryPage />} />
      <Route path="/p/:projectId" element={<ProjectPage />} />
      <Route path="/transfers" element={<TransfersPage />} />
      <Route path="/watch/:id" element={<PlayerPage />} />
      <Route path="/admin" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
