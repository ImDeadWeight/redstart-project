import { createRoot } from 'react-dom/client'
import App from './App'
import { AdminGate } from './components/AdminGate'
import './index.css'

// AdminGate is a pass-through inside Electron, where the preload bridge is the
// credential. Served to a browser by the admin listener, it is the sign-in (or
// first-run setup) screen that has to come before anything else can be called.
createRoot(document.getElementById('root')!).render(
  <AdminGate>
    <App />
  </AdminGate>
)
