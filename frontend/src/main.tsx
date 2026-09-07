import React from 'react'
import ReactDOM from 'react-dom/client'
import { Gate } from './Gate'
import App from './App'
import './style.css'

// Our frontend is served from the Memphis origin itself
// (memphis.mercaturaforum.com/_/raw/<cid>/...), so we use our own <Gate>
// (a thin wrapper over @thebes/sdk's useMemphis — see Gate.tsx for why we
// don't use the SDK's own <MemphisGate> directly) — apps on their OWN
// custom domain would use useMemphisConnect instead (see thebes-sdk
// docs/memphis.md, section 4).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Gate appName="Mercature Notes" tagline="Sign in to your notes.">
      <App />
    </Gate>
  </React.StrictMode>,
)
