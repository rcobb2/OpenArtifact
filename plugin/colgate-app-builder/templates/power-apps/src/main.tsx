import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initialize } from '@microsoft/power-apps/app';
import App from './App';

// Power Apps hands the app its connector context at startup; render only once
// that has resolved, so data-source calls never run against an uninitialised SDK.
initialize()
  .catch((e: unknown) => console.error('Power SDK initialize failed', e))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
