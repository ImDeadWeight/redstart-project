import { createRoot } from 'react-dom/client'
import App from './App'
import { AdminGate } from './components/AdminGate'
import './index.css'

// AdminGate is the sign-in (or first-run setup) screen that has to come
// before anything else can be called — for a browser tab and for the
// Electron window alike, since Phase 6 §6.2 retired the preload bridge that
// used to let Electron skip it.
createRoot(document.getElementById('root')!).render(
  <AdminGate>
    <App />
  </AdminGate>
)
