/// <reference types="vite/client" />

// Declares Vite's ambient module types — notably that `import './index.css'`
// and other asset imports are valid side-effect modules. Without this file
// TypeScript reports "Cannot find module or type declarations for side-effect
// import of './index.css'" on src/main.tsx.
//
// The chat-ui package has its own equivalent; this one covers the launcher.
