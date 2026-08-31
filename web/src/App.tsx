import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import UploaderPage from './pages/UploaderPage';
import BrowsePage from './pages/BrowsePage';
import PlayerPage from './pages/PlayerPage';
import EditorPage from './pages/EditorPage';
import AdminPage from './pages/AdminPage';

function Shell() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-950 text-slate-500">
        <p className="text-sm">Loading…</p>
      </main>
    );
  }
  if (!user) return <LoginPage />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<UploaderPage />} />
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/watch/:id" element={<PlayerPage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/admin" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
