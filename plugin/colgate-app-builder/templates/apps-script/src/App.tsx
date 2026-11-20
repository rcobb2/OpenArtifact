import { useEffect, useState } from 'react';
import { getCurrentUser } from './gas';

export default function App() {
  const [email, setEmail] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    getCurrentUser().then((u) => setEmail(u.email)).catch((e) => setError(e.message));
  }, []);

  return (
    <main style={{ font: '15px/1.6 system-ui, sans-serif', padding: 32, maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>Colgate App</h1>
      <p style={{ color: '#666', margin: '0 0 24px' }}>
        {email ? `Signed in as ${email}` : error || 'Loading…'}
      </p>
      {/* Replace with the app's real UI. */}
    </main>
  );
}
